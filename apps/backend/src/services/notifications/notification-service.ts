import { Role } from '@prisma/client';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { rootPrisma } from '../../lib/prisma.js';
import { renderNotificationTemplates } from './templates.js';
import type { NotificationChannel, NotificationEvent, NotificationMessage } from './types.js';

type RoleRecipient = {
  userId: string;
  name: string;
  email: string;
};

const DEFAULT_TARGET_ROLES: Role[] = [Role.ADMIN, Role.CHIEF_ACCOUNTANT, Role.MANAGER];
const ALL_CHANNELS: NotificationChannel[] = ['email', 'sms', 'push'];

const channelWebhookEnvMap: Record<NotificationChannel, string | undefined> = {
  email: env.NOTIFICATION_EMAIL_WEBHOOK_URL,
  sms: env.NOTIFICATION_SMS_WEBHOOK_URL,
  push: env.NOTIFICATION_PUSH_WEBHOOK_URL,
};

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function uniqueStrings(values: string[], caseInsensitive = false): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const key = caseInsensitive ? value.toLowerCase() : value;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(value);
  }
  return deduped;
}

function resolveEnabledChannels(): NotificationChannel[] {
  const configured = parseCsv(env.NOTIFICATION_CHANNELS)
    .map((value) => value.toLowerCase())
    .filter((value): value is NotificationChannel => ALL_CHANNELS.includes(value as NotificationChannel));

  return configured.length > 0 ? uniqueChannels(configured) : ['email'];
}

function resolveTargetRoles(event: NotificationEvent): Role[] {
  if (event.targetRoles && event.targetRoles.length > 0) {
    return uniqueRoles(event.targetRoles);
  }

  const roleValues = parseCsv(env.NOTIFICATION_TARGET_ROLES).map((value) => value.toUpperCase());
  const parsedRoles = roleValues.filter((value): value is Role => Object.values(Role).includes(value as Role));

  if (parsedRoles.length === 0) {
    return DEFAULT_TARGET_ROLES;
  }

  return uniqueRoles(parsedRoles);
}

function uniqueRoles(roles: Role[]): Role[] {
  const seen = new Set<Role>();
  const deduped: Role[] = [];
  for (const role of roles) {
    if (seen.has(role)) {
      continue;
    }
    seen.add(role);
    deduped.push(role);
  }
  return deduped;
}

function uniqueChannels(channels: NotificationChannel[]): NotificationChannel[] {
  const seen = new Set<NotificationChannel>();
  const deduped: NotificationChannel[] = [];
  for (const channel of channels) {
    if (seen.has(channel)) {
      continue;
    }
    seen.add(channel);
    deduped.push(channel);
  }
  return deduped;
}

async function resolveRoleRecipients(event: NotificationEvent): Promise<RoleRecipient[]> {
  const roles = resolveTargetRoles(event);
  const memberships = await rootPrisma.userCompanyMembership.findMany({
    where: {
      companyId: event.companyId,
      role: {
        in: roles,
      },
    },
    select: {
      userId: true,
      user: {
        select: {
          name: true,
          email: true,
        },
      },
    },
  });

  const recipientsMap = new Map<string, RoleRecipient>();
  for (const membership of memberships) {
    const userEmail = membership.user.email?.trim();
    if (!userEmail) {
      continue;
    }

    if (!env.NOTIFICATION_INCLUDE_ACTOR && event.triggeredByUserId && membership.userId === event.triggeredByUserId) {
      continue;
    }

    if (recipientsMap.has(membership.userId)) {
      continue;
    }

    recipientsMap.set(membership.userId, {
      userId: membership.userId,
      name: membership.user.name,
      email: userEmail,
    });
  }

  return [...recipientsMap.values()];
}

function resolveChannelRecipients(channel: NotificationChannel, roleRecipients: RoleRecipient[]): string[] {
  if (channel === 'email') {
    const configuredEmails = parseCsv(env.NOTIFICATION_EMAIL_RECIPIENTS);
    const userEmails = roleRecipients.map((recipient) => recipient.email);
    return uniqueStrings([...userEmails, ...configuredEmails], true);
  }

  if (channel === 'sms') {
    return uniqueStrings(parseCsv(env.NOTIFICATION_SMS_RECIPIENTS));
  }

  return uniqueStrings(parseCsv(env.NOTIFICATION_PUSH_RECIPIENTS));
}

async function postToWebhook(url: string, payload: unknown): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.NOTIFICATION_HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      throw new Error(
        `Webhook response ${response.status} ${response.statusText}${responseText ? ` - ${responseText.slice(0, 200)}` : ''}`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function dispatchChannel(
  channel: NotificationChannel,
  event: NotificationEvent,
  message: NotificationMessage,
  recipients: string[],
): Promise<void> {
  if (recipients.length === 0) {
    logger.info('notification_channel_skipped', {
      channel,
      reason: 'no_recipients',
      eventType: event.type,
      companyId: event.companyId,
    });
    return;
  }

  const webhookUrl = channelWebhookEnvMap[channel];
  if (!webhookUrl) {
    logger.info('notification_channel_simulated', {
      channel,
      eventType: event.type,
      companyId: event.companyId,
      recipients,
      subject: message.subject ?? null,
      title: message.title ?? null,
      body: message.body,
    });
    return;
  }

  await postToWebhook(webhookUrl, {
    channel,
    eventType: event.type,
    companyId: event.companyId,
    companyName: event.companyName ?? null,
    occurredAt: event.occurredAt ?? new Date().toISOString(),
    recipients,
    message,
  });

  logger.info('notification_channel_sent', {
    channel,
    eventType: event.type,
    companyId: event.companyId,
    recipientsCount: recipients.length,
  });
}

export async function dispatchNotificationEvent(event: NotificationEvent): Promise<void> {
  if (!env.NOTIFICATIONS_ENABLED) {
    return;
  }

  const roleRecipients = await resolveRoleRecipients(event);
  const templates = renderNotificationTemplates(event);
  const channels = resolveEnabledChannels();

  let failures = 0;
  for (const channel of channels) {
    const recipients = resolveChannelRecipients(channel, roleRecipients);
    try {
      await dispatchChannel(channel, event, templates[channel], recipients);
    } catch (error) {
      failures += 1;
      logger.error('notification_channel_failed', {
        channel,
        eventType: event.type,
        companyId: event.companyId,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { value: error },
      });
    }
  }

  if (failures > 0) {
    throw new Error(`Trimiterea notificărilor a eșuat pe ${failures} canal(e).`);
  }
}

export const __internal = {
  parseCsv,
  resolveEnabledChannels,
  resolveTargetRoles,
  resolveChannelRecipients,
};

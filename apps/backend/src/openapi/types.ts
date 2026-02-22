export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export type EndpointSecurity = 'public' | 'protected';

export interface EndpointDescriptor {
  method: HttpMethod;
  path: string;
  tag: string;
  source: string;
  summary: string;
  operationId: string;
  security: EndpointSecurity;
}

export function endpointKey(method: HttpMethod, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

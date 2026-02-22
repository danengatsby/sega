import { useState } from 'react';
import type { User } from '../types';

export function useAuthStorage(): {
  user: User | null;
  setSession: (user: User) => void;
  clearSession: () => void;
} {
  const [user, setUser] = useState<User | null>(null);

  function setSession(nextUser: User): void {
    setUser(nextUser);
  }

  function clearSession(): void {
    setUser(null);
  }

  return {
    user,
    setSession,
    clearSession,
  };
}

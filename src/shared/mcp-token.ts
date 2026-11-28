/** A token as Wirescry makes them for its MCP server: 32 random bytes, base64url (43 characters). */
export function isMcpToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export const redactEnv = (env: Record<string, string | undefined>): Record<string, string | undefined> => {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [
    key,
    /^LX_USER_|PASSWORD|SECRET|TOKEN|KEY/i.test(key) ? '***' : value,
  ]))
}

export const formatEnvForLog = (env: Record<string, string | undefined>): string => {
  return Object.entries(redactEnv(env)).map(([key, value]) => `${key}: ${value as string}`).join('\n  ')
}

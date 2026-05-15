export const logger = {
  error: (...args: Parameters<typeof console.error>) => console.error(...args),
  info: (...args: Parameters<typeof console.info>) => console.info(...args),
  warn: (...args: Parameters<typeof console.warn>) => console.warn(...args),
};

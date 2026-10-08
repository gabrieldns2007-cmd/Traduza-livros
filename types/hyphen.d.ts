declare module "hyphen/*" {
  export function hyphenateSync(text: string, options?: { hyphenChar?: string; minWordLength?: number }): string;
  const _default: { hyphenateSync: typeof hyphenateSync };
  export default _default;
}

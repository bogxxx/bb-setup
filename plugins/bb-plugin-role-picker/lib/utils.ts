/** Host id of the source marked default, if there is one. */
export function defaultSourceHostId(
  sources: readonly { isDefault: boolean; hostId: string }[],
): string | undefined {
  return sources.find((source) => source.isDefault)?.hostId;
}

export function formatHomePathForDisplay(pathValue: string): string {
  const homePrefix =
    pathValue.match(/^\/Users\/[^/]+(?=\/|$)/)?.[0] ??
    pathValue.match(/^\/home\/[^/]+(?=\/|$)/)?.[0] ??
    pathValue.match(/^\/root(?=\/|$)/)?.[0] ??
    pathValue.match(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+(?=[\\/]|$)/i)?.[0];
  return homePrefix === undefined
    ? pathValue
    : `~${pathValue.slice(homePrefix.length)}`;
}

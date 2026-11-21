// Is the phone on mobile data? Used by the "Wide traffic: Wi-Fi only" setting.

/**
 * False only when the browser says the connection is cellular. Android's WebView reports the
 * connection type (Network Information API); where it isn't reported (desktop browsers), assume
 * it isn't mobile data.
 */
export function onWifi(): boolean {
  const type = (navigator as any).connection?.type as string | undefined;
  return type !== 'cellular';
}

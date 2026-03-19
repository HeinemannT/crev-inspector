/**
 * Cookie-based fast BMP detection gate.
 * Checks for JSESSIONID cookie presence as an early BMP signal.
 */

export async function checkBmpCookie(url: string): Promise<boolean> {
  try {
    const cookie = await chrome.cookies.get({ url, name: 'JSESSIONID' });
    return cookie != null;
  } catch {
    return false;
  }
}

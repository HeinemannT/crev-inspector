// @vitest-environment happy-dom

import { expect, it, vi } from 'vitest';
import { installCloseHandshake } from '../frame-close-handshake';

it('runs accepted-close cleanup only after the close guard approves', async () => {
  let allowed = false;
  const onAccepted = vi.fn();
  const postMessage = vi.spyOn(window.parent, 'postMessage');
  installCloseHandshake(() => allowed, onAccepted);

  const request = () => {
    const event = new MessageEvent('message', { data: { type: 'CREV_OVERLAY_CLOSE_REQUEST' } });
    Object.defineProperty(event, 'source', { value: window.parent });
    window.dispatchEvent(event);
  };

  request();
  await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith(
    { type: 'CREV_OVERLAY_CLOSE_RESPONSE', ok: false }, '*',
  ));
  expect(onAccepted).not.toHaveBeenCalled();

  allowed = true;
  request();
  await vi.waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
  expect(postMessage).toHaveBeenCalledWith(
    { type: 'CREV_OVERLAY_CLOSE_RESPONSE', ok: true }, '*',
  );
});

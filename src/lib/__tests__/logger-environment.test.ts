import { afterEach, describe, expect, it, vi } from 'vitest';

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

function restoreGlobal(name: 'localStorage' | 'window', descriptor?: PropertyDescriptor): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, name);
  }
}

afterEach(() => {
  restoreGlobal('localStorage', originalLocalStorage);
  restoreGlobal('window', originalWindow);
  vi.resetModules();
});

describe('logger environment detection', () => {
  it("does not touch Node's ambient localStorage when there is no window", async () => {
    let localStorageRead = false;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        localStorageRead = true;
        throw new Error('Node localStorage should not be read');
      },
    });

    vi.resetModules();
    await import('../logger');

    expect(localStorageRead).toBe(false);
  });
});

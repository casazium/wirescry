/**
 * The relay's tests again, with the relay behind the pipe helper (native/docker-pipe) as it runs on
 * Windows: Docker clients reach the relay through the helper, and every connection the relay makes
 * to Docker goes through it too. Off Windows the helper uses Unix sockets in place of named pipes,
 * so this runs everywhere; test/docker-windows.test.ts runs it with real pipes and Docker.
 */
import { describe, it } from 'vitest';
import { pipeHelperForTests } from './pipe-helper-binary';

const helper = pipeHelperForTests();
(globalThis as { __wirescryRelayHelper?: string }).__wirescryRelayHelper = helper;

if (helper) await import('./docker-relay.test');
else
  describe('Docker relay through the pipe helper', () => {
    it.skip('needs Go to build the helper (native/docker-pipe)', () => undefined);
  });

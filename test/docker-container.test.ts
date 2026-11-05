import { describe, expect, it } from 'vitest';
import {
  COMPOSE_HASH_LABEL,
  HASH_SUFFIX,
  LABELS,
  MOUNT_POINT,
  containerEnv,
  labelsAsListed,
  namesInDefinition,
  rewriteListed,
  setUpContainer,
  userNetworks,
} from '../src/backend/docker/container';

const options = { proxyPort: 8001, configDir: '/data/docker-config', direct: [] as string[] };
type Body = {
  Env: string[];
  Labels: Record<string, string>;
  HostConfig: { Mounts?: unknown[]; ExtraHosts?: string[]; NetworkMode?: string; Binds?: string[] };
};
const setUp = (input: unknown, extra: Partial<typeof options> = {}) => {
  const result = setUpContainer(input, { ...options, ...extra });
  return { ...result, body: result.body as unknown as Body };
};
const envOf = (body: Body): Map<string, string> =>
  new Map(
    body.Env.filter((e) => e.includes('=')).map((e) => [
      e.slice(0, e.indexOf('=')),
      e.slice(e.indexOf('=') + 1),
    ]),
  );

describe('containerEnv', () => {
  it('points at the host by host.docker.internal and at files in the mount', () => {
    const env = containerEnv(8001);
    expect(env.HTTP_PROXY).toBe('http://host.docker.internal:8001');
    expect(env.https_proxy).toBe('http://host.docker.internal:8001');
    expect(env.NODE_EXTRA_CA_CERTS).toBe(`${MOUNT_POINT}/ca.pem`);
    expect(env.SSL_CERT_FILE).toBe(`${MOUNT_POINT}/ca-bundle.pem`);
    expect(env.PHP_INI_SCAN_DIR).toBe(`:${MOUNT_POINT}/php`);
    expect(env.JAVA_TOOL_OPTIONS).toContain('-Dhttps.proxyHost=host.docker.internal');
    expect(env.JAVA_TOOL_OPTIONS).toContain(
      `-Djavax.net.ssl.trustStore="${MOUNT_POINT}/java/wirescry-truststore.jks"`,
    );
  });
});

describe('setUpContainer', () => {
  it('adds the proxy settings, the certificate mount and the host name', () => {
    const { setUp: done, body } = setUp({ Image: 'node:22', Env: ['APP=1'] });
    expect(done).toBe(true);
    const env = envOf(body);
    expect(env.get('APP')).toBe('1');
    expect(env.get('HTTPS_PROXY')).toBe('http://host.docker.internal:8001');
    expect(env.get('NO_PROXY')).toBe('localhost,127.0.0.1,::1');
    expect(env.get('no_proxy')).toBe('localhost,127.0.0.1,::1');
    expect(body.HostConfig.Mounts).toEqual([
      { Type: 'bind', Source: '/data/docker-config', Target: MOUNT_POINT, ReadOnly: true },
    ]);
    expect(body.HostConfig.ExtraHosts).toEqual(['host.docker.internal:host-gateway']);
    expect(body.Labels[LABELS.setup]).toBe('proxy');
    expect(body.Labels[LABELS.port]).toBe('8001');
  });

  it('works on a definition with no environment, host config or labels', () => {
    const { setUp: done, body } = setUp({ Image: 'alpine' });
    expect(done).toBe(true);
    expect(envOf(body).get('HTTP_PROXY')).toBe('http://host.docker.internal:8001');
  });

  it('leaves the input as it was', () => {
    const input = { Image: 'alpine', Env: ['A=1'], HostConfig: { Mounts: [] as unknown[] }, Labels: {} };
    const copy = structuredClone(input);
    setUp(input);
    expect(input).toEqual(copy);
  });

  it('replaces proxy variables the container set, and keeps one of each', () => {
    const { body } = setUp({
      Env: ['HTTP_PROXY=http://corp:3128', 'http_proxy=http://corp:3128', 'KEEP=yes'],
    });
    expect(body.Env.filter((e) => e.startsWith('HTTP_PROXY='))).toEqual([
      'HTTP_PROXY=http://host.docker.internal:8001',
    ]);
    expect(body.Env.filter((e) => e.startsWith('http_proxy='))).toEqual([
      'http_proxy=http://host.docker.internal:8001',
    ]);
    expect(body.Env).toContain('KEEP=yes');
  });

  it("merges the container's NO_PROXY, both cases, with the names to skip, without repeats", () => {
    const { body } = setUp(
      { Env: ['NO_PROXY=internal.example,localhost', 'no_proxy=db, cache'] },
      { direct: ['db', 'API', 'api'] },
    );
    expect(envOf(body).get('NO_PROXY')).toBe('internal.example,localhost,db,cache,127.0.0.1,::1,API');
  });

  it("adds its Java options after the container's own, and keeps the container's PHP folders", () => {
    const { body } = setUp({
      Env: ['JAVA_TOOL_OPTIONS=-Xmx512m', 'PHP_INI_SCAN_DIR=/usr/local/etc/php/conf.d'],
    });
    const env = envOf(body);
    expect(env.get('JAVA_TOOL_OPTIONS')).toMatch(/^-Xmx512m -Dhttp\.proxyHost=host\.docker\.internal /);
    expect(env.get('PHP_INI_SCAN_DIR')).toBe(`/usr/local/etc/php/conf.d:${MOUNT_POINT}/php`);
  });

  it('ignores an empty JAVA_TOOL_OPTIONS', () => {
    const { body } = setUp({ Env: ['JAVA_TOOL_OPTIONS='] });
    expect(envOf(body).get('JAVA_TOOL_OPTIONS')).toMatch(/^-Dhttp\.proxyHost/);
  });

  it('keeps entries without a value, which tell Docker to leave a variable out', () => {
    const { body } = setUp({ Env: ['UNSET_ME', 'HTTP_PROXY'] });
    expect(body.Env).toContain('UNSET_ME');
    // Ours replaces it.
    expect(body.Env).not.toContain('HTTP_PROXY');
  });

  it("keeps the container's own mounts and host entries", () => {
    const { body } = setUp({
      HostConfig: {
        Binds: ['/src:/app'],
        Mounts: [{ Type: 'volume', Source: 'data', Target: '/data' }],
        ExtraHosts: ['db.local:10.0.0.5'],
      },
    });
    expect(body.HostConfig.Binds).toEqual(['/src:/app']);
    expect(body.HostConfig.Mounts).toHaveLength(2);
    expect(body.HostConfig.ExtraHosts).toEqual(['db.local:10.0.0.5', 'host.docker.internal:host-gateway']);
  });

  it('keeps a host.docker.internal entry the container has, in either form', () => {
    for (const entry of ['host.docker.internal:10.1.1.1', 'HOST.DOCKER.INTERNAL=10.1.1.1']) {
      const { body } = setUp({ HostConfig: { ExtraHosts: [entry] } });
      expect(body.HostConfig.ExtraHosts).toEqual([entry]);
    }
  });

  it("adds no host entry to a container sharing another's network, which Docker would refuse", () => {
    const { setUp: done, body } = setUp({ HostConfig: { NetworkMode: 'container:abc123' } });
    expect(done).toBe(true);
    expect(body.HostConfig.ExtraHosts).toBeUndefined();
  });

  it('skips a container with no network, labelled so', () => {
    const result = setUp({ Env: ['A=1'], HostConfig: { NetworkMode: 'none' } });
    expect(result.setUp).toBe(false);
    expect(result.body.Env).toEqual(['A=1']);
    expect(result.body.HostConfig.Mounts).toBeUndefined();
    expect(result.body.Labels[LABELS.setup]).toBe('skipped');
  });

  it('skips a container that already mounts something at or around the mount point', () => {
    for (const hostConfig of [
      { Binds: ['/x:/run/wirescry:ro'] },
      { Binds: ['/x:/run'] },
      { Mounts: [{ Type: 'tmpfs', Target: '/run/wirescry/sub' }] },
      { Mounts: [{ Type: 'tmpfs', Target: '/run/' }] },
    ]) {
      const result = setUp({ HostConfig: hostConfig });
      expect(result.setUp, JSON.stringify(hostConfig)).toBe(false);
    }
    // A mount elsewhere under /run is fine, and so is a host folder that happens to have that path.
    expect(setUp({ HostConfig: { Binds: ['/x:/run/secrets'] } }).setUp).toBe(true);
    expect(setUp({ HostConfig: { Binds: ['/run/wirescry:/data'] } }).setUp).toBe(true);
    expect(setUp({ HostConfig: { Binds: ['C:\\data:/run/wirescry'] } }).setUp).toBe(false);
  });

  it('leaves alone what it does not understand', () => {
    expect(setUp('nonsense').setUp).toBe(false);
    expect(setUp(null).setUp).toBe(false);
    expect(setUp([1, 2]).setUp).toBe(false);
    const odd = { Env: 'A=1' };
    const result = setUpContainer(odd, options);
    expect(result.setUp).toBe(false);
    expect(result.body).toBe(odd);
  });

  it("changes Compose's hash and keeps the original", () => {
    const { body } = setUp({ Labels: { [COMPOSE_HASH_LABEL]: 'abc', 'com.docker.compose.service': 'web' } });
    expect(body.Labels[COMPOSE_HASH_LABEL]).toBe(`abc${HASH_SUFFIX}`);
    expect(body.Labels[LABELS.composeHash]).toBe('abc');
    expect(body.Labels['com.docker.compose.service']).toBe('web');
  });

  it("doesn't change Compose's hash on a skipped container", () => {
    const { body } = setUp({ Labels: { [COMPOSE_HASH_LABEL]: 'abc' }, HostConfig: { NetworkMode: 'none' } });
    expect(body.Labels[COMPOSE_HASH_LABEL]).toBe('abc');
  });
});

describe('labelsAsListed', () => {
  const hash = { [COMPOSE_HASH_LABEL]: 'abc' };
  it('reports the original hash for a container set up for this port', () => {
    const labels = {
      [COMPOSE_HASH_LABEL]: `abc${HASH_SUFFIX}`,
      [LABELS.setup]: 'proxy',
      [LABELS.port]: '8001',
      [LABELS.composeHash]: 'abc',
    };
    expect(labelsAsListed(labels, 8001)).toEqual({ ...labels, [COMPOSE_HASH_LABEL]: 'abc' });
  });
  it('leaves the changed hash on one set up for another port, so it is recreated', () => {
    const labels = {
      [COMPOSE_HASH_LABEL]: `abc${HASH_SUFFIX}`,
      [LABELS.setup]: 'proxy',
      [LABELS.port]: '9000',
      [LABELS.composeHash]: 'abc',
    };
    expect(labelsAsListed(labels, 8001)).toBe(labels);
  });
  it('changes the hash of a container not set up, so it is recreated', () => {
    expect(labelsAsListed(hash, 8001)).toEqual({ [COMPOSE_HASH_LABEL]: `abc${HASH_SUFFIX}` });
  });
  it('leaves a skipped container as it is, so it is not recreated every time', () => {
    const labels = { ...hash, [LABELS.setup]: 'skipped' };
    expect(labelsAsListed(labels, 8001)).toBe(labels);
  });
  it('leaves containers Compose does not manage alone', () => {
    const labels = { other: 'x' };
    expect(labelsAsListed(labels, 8001)).toBe(labels);
    expect(labelsAsListed(null, 8001)).toBe(null);
  });
});

describe('rewriteListed', () => {
  it('changes labels in a list and in an inspect reply', () => {
    const list = [{ Id: 'a', Labels: { [COMPOSE_HASH_LABEL]: 'h' } }, { Id: 'b', Labels: {} }, 'odd'];
    expect(rewriteListed(list, 8001)).toEqual([
      { Id: 'a', Labels: { [COMPOSE_HASH_LABEL]: `h${HASH_SUFFIX}` } },
      { Id: 'b', Labels: {} },
      'odd',
    ]);
    const inspect = { Id: 'a', Config: { Image: 'x', Labels: { [COMPOSE_HASH_LABEL]: 'h' } } };
    expect(rewriteListed(inspect, 8001)).toEqual({
      Id: 'a',
      Config: { Image: 'x', Labels: { [COMPOSE_HASH_LABEL]: `h${HASH_SUFFIX}` } },
    });
  });
  it('returns anything else as it is', () => {
    const odd = { message: 'no such container' };
    expect(rewriteListed(odd, 8001)).toBe(odd);
  });
});

describe('names and networks', () => {
  it('collects aliases and links', () => {
    expect(
      namesInDefinition({
        NetworkingConfig: {
          EndpointsConfig: { app_default: { Aliases: ['web', 'web-1'], Links: ['db:database'] } },
        },
        HostConfig: { Links: ['/cache:/web/redis'] },
      }),
    ).toEqual(['web', 'web-1', 'db', 'database', 'cache', 'redis']);
  });
  it('drops names that are not host names', () => {
    expect(
      namesInDefinition({
        NetworkingConfig: { EndpointsConfig: { n: { Aliases: ['ok', '${BAD}', '', 'a b'] } } },
      }),
    ).toEqual(['ok']);
  });
  it('lists user-defined networks only', () => {
    expect(
      userNetworks({
        HostConfig: { NetworkMode: 'app_default' },
        NetworkingConfig: { EndpointsConfig: { app_default: {}, backend: {}, bridge: {} } },
      }),
    ).toEqual(['app_default', 'backend']);
    expect(userNetworks({ HostConfig: { NetworkMode: 'host' } })).toEqual([]);
    expect(userNetworks({ HostConfig: { NetworkMode: 'container:x' } })).toEqual([]);
  });
});

/** Hostname the proxy answers itself, for in-browser setup. Never resolved in DNS: only reachable through the proxy. */
export const SETUP_HOST = 'wirescry.internal';

/**
 * Served at http://wirescry.internal/ to a browser using the proxy. It links to the
 * certificate, then checks over HTTPS whether the browser now trusts it.
 */
export function setupPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wirescry setup</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 560px; margin: 48px auto; padding: 0 16px; line-height: 1.5; }
  a.button { display: inline-block; padding: 8px 14px; border-radius: 6px; background: #2f6fde; color: #fff; text-decoration: none; }
  #status { margin-top: 24px; padding: 12px; border-radius: 6px; border: 1px solid #8884; }
  .ok { color: #1f8a4c; }
</style>
</head>
<body>
<h1>Wirescry setup</h1>
<p>This browser is sending its traffic through Wirescry. To see HTTPS traffic, it needs to trust Wirescry's certificate once.</p>
<p><a class="button" href="/certificate">Install certificate</a></p>
<p>When Firefox asks, tick <strong>Trust this CA to identify websites</strong>, then click <strong>OK</strong>.</p>
<p id="status">Checking whether this browser trusts the certificate…</p>
<script>
  const status = document.getElementById('status');
  async function check() {
    try {
      const response = await fetch('https://${SETUP_HOST}/check', { cache: 'no-store' });
      if (response.ok) {
        status.className = 'ok';
        status.innerHTML = 'Certificate trusted. HTTPS traffic from this browser now shows in Wirescry. <a href="https://example.com/">Continue to example.com</a>';
        return;
      }
    } catch {}
    status.textContent = 'Not trusted yet. Install the certificate above.';
    setTimeout(check, 1500);
  }
  check();
</script>
</body>
</html>
`;
}

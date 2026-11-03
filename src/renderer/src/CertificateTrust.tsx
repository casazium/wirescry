import type { ProxyStatus } from '../../shared/api';

interface Props {
  platform: ProxyStatus['platform'];
  certPath: string;
  commonName: string;
  CopyButton: (props: { text: string }) => React.JSX.Element;
}

const posixQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

function Command({ text, CopyButton }: { text: string; CopyButton: Props['CopyButton'] }): React.JSX.Element {
  return (
    <div className="snippet">
      <pre className="code">{text}</pre>
      <CopyButton text={text} />
    </div>
  );
}

/**
 * Steps for trusting Wirescry's certificate system-wide, for apps Wirescry doesn't launch.
 * Browsers and terminals that Wirescry opens already trust it, so this is folded away.
 */
export function CertificateTrust({ platform, certPath, commonName, CopyButton }: Props): React.JSX.Element {
  return (
    <details className="coverage">
      <summary>How to trust the certificate on this computer</summary>
      <p className="muted">
        Only needed for apps Wirescry doesn't open itself, such as desktop apps or other browsers. Anything
        that trusts this certificate will accept traffic Wirescry intercepts, so remove it when you no longer
        need it. Its private key never leaves this computer.
      </p>
      {platform === 'darwin' && (
        <>
          <p>Run this in Terminal. macOS asks for your password to confirm.</p>
          <Command
            text={`security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db ${posixQuote(certPath)}`}
            CopyButton={CopyButton}
          />
          <p className="muted">
            Or double-click the saved certificate, open it in Keychain Access, and under Trust set &quot;When
            using this certificate&quot; to Always Trust. To remove it, delete &quot;{commonName}&quot; from
            the login keychain.
          </p>
        </>
      )}
      {platform === 'win32' && (
        <>
          <p>Run this in PowerShell or Command Prompt. Windows asks you to confirm.</p>
          <Command text={`certutil -user -addstore Root "${certPath}"`} CopyButton={CopyButton} />
          <p className="muted">It trusts the certificate for your Windows account only. To remove it:</p>
          <Command text={`certutil -user -delstore Root "${commonName}"`} CopyButton={CopyButton} />
          <p className="muted">
            Firefox keeps its own list: in its settings, open Certificates, View Certificates, Authorities,
            and import the saved file.
          </p>
        </>
      )}
      {(platform === 'linux' || platform === 'other') && (
        <>
          <p>Debian and Ubuntu:</p>
          <Command
            text={`sudo cp ${posixQuote(certPath)} /usr/local/share/ca-certificates/wirescry.crt && sudo update-ca-certificates`}
            CopyButton={CopyButton}
          />
          <p>Fedora, Arch and others with p11-kit:</p>
          <Command text={`sudo trust anchor ${posixQuote(certPath)}`} CopyButton={CopyButton} />
          <p className="muted">
            Chrome and Firefox keep their own lists. For Chrome (needs libnss3-tools or nss-tools):
          </p>
          <Command
            text={`certutil -d sql:$HOME/.pki/nssdb -A -t C,, -n Wirescry -i ${posixQuote(certPath)}`}
            CopyButton={CopyButton}
          />
          <p className="muted">
            For Firefox: in its settings, open Certificates, View Certificates, Authorities, and import the
            saved file.
          </p>
        </>
      )}
    </details>
  );
}

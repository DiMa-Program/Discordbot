import { config } from 'dotenv';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

config({ path: '.env' });

const user = process.env.HEAVEN_SFTP_USER ?? '';
const host = process.env.HEAVEN_SFTP_HOST ?? '';
const port = process.env.HEAVEN_SFTP_PORT ?? '2022';
const password = process.env.HEAVEN_SFTP_PASSWORD ?? '';
const hostKey = 'ssh-ed25519 255 HjV7vEkMibVIR+NApBvRtt58JlwLERfc2fJcTjkDt2U';
const winscp = 'C:\\Users\\DiMa\\AppData\\Local\\Programs\\WinSCP\\WinSCP.com';

const iniPath = path.join(tmpdir(), `wx-${process.pid}.ini`);
const scriptPath = path.join(tmpdir(), `wx-${process.pid}.txt`);

writeFileSync(
  iniPath,
  `[Configuration]\r\n[Session\\deploy]\r\nHostName=${host}\r\nPortNumber=${port}\r\nUserName=${user}\r\nProtocol=SFTP\r\nPuttyProtocol=putty-sftp\r\nTimeout=25\r\n`,
  'utf8',
);

const commands = process.argv.slice(2);

writeFileSync(
  scriptPath,
  [
    `open sftp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/ -hostkey="${hostKey}"`,
    ...commands,
    'exit',
  ].join('\r\n') + '\r\n',
  'utf8',
);

const run1 = spawnSync(winscp, ['/ini=' + iniPath, '/script=' + scriptPath], {
  encoding: 'utf8',
  windowsHide: true,
});

console.log((run1.stdout ?? '').replace(/\r/g, '').split(password).join('<REDACTED>'));

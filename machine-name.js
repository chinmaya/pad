const os = require('os');

function sanitizeMachineName(value) {
  const sanitized = String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9-_]/g, '');
  return sanitized;
}

function getCliArgValue(names) {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    for (const name of names) {
      if (arg === name) {
        const next = process.argv[i + 1];
        if (next && !next.startsWith('--')) {
          return next;
        }
      }

      if (arg.startsWith(`${name}=`)) {
        return arg.slice(name.length + 1);
      }
    }
  }

  return null;
}

function getConfiguredMachineName() {
  const envValue = process.env.PAD_MACHINE_NAME || process.env.PAD_BACKUP_MACHINE_NAME;
  const cliValue = getCliArgValue(['--machine-name', '--pad-machine-name']);
  const override = sanitizeMachineName(cliValue || envValue);
  if (override) {
    return override;
  }

  const hostname = sanitizeMachineName(os.hostname());
  return hostname || 'unknown';
}

module.exports = {
  getConfiguredMachineName,
  sanitizeMachineName,
};


const { spawnHidden } = require('./util');

const PROFILES = {
  eco: { label: 'Eco', priority: 'BelowNormal' },
  balanced: { label: 'Balanced', priority: 'Normal' },
  performance: { label: 'Performance', priority: 'AboveNormal' },
  maximum: { label: 'Maximum', priority: 'High' }
};

function applyPerformanceProfile(pid, profile = 'balanced', timeoutMs = 5000) {
  const config = PROFILES[profile] || PROFILES.balanced;
  if (process.platform !== 'win32' || !Number.isInteger(Number(pid))) {
    return Promise.resolve({ profile, applied: false, reason: 'unsupported-platform' });
  }
  const safePid = Number(pid);
  const escaped = String(config.priority).replace(/'/g, "''");
  return new Promise(resolve => {
    const ps = `$p=Get-Process -Id ${safePid} -ErrorAction Stop; $p.PriorityClass='${escaped}'; [pscustomobject]@{Id=$p.Id;Priority=$p.PriorityClass} | ConvertTo-Json -Compress`;
    const child = spawnHidden('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',ps], { stdio:['ignore','pipe','ignore'] });
    let out='';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ profile, applied: false, priority: config.priority, reason: 'timeout' });
    }, Math.max(1000, Number(timeoutMs) || 5000));
    child.stdout.on('data', b => {
      out += b.toString();
      if (out.length > 8192) out = out.slice(-8192);
    });
    child.once('close', code => finish({ profile, applied: code === 0, priority: config.priority, output: out.trim() }));
    child.once('error', () => finish({ profile, applied: false, priority: config.priority, reason: 'spawn-error' }));
  });
}

module.exports = { PROFILES, applyPerformanceProfile };

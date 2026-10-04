const { EventEmitter } = require('events');

const DAY = 24 * 60 * 60 * 1000;

function nextWipeTime(lastAt, frequency = 'monthly', hour = 19, weekday = 4) {
  const now = new Date();
  const targetHour = Math.max(0, Math.min(23, Number(hour) || 0));
  const targetDay = Math.max(0, Math.min(6, Number(weekday) || 0));

  if (lastAt) {
    const base = new Date(Number(lastAt));
    const next = new Date(base);
    if (frequency === 'weekly') next.setDate(next.getDate() + 7);
    else if (frequency === 'biweekly') next.setDate(next.getDate() + 14);
    else next.setMonth(next.getMonth() + 1);
    next.setHours(targetHour, 0, 0, 0);
    return next;
  }

  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(targetHour, 0, 0, 0);
  while (next.getDay() !== targetDay || next <= now) next.setDate(next.getDate() + 1);
  return next;
}

class Scheduler extends EventEmitter {
  constructor(store, servers, backups, rcon = null, umod = null) {
    super();
    this.store = store;
    this.servers = servers;
    this.backups = backups;
    this.rcon = rcon;
    this.umod = umod;
    this.timer = null;
    this.running = new Set();
  }

  start() {
    this.stop();
    this.tick().catch(error => this.report('Scheduler error', error));
    const interval = Math.max(5000, Number(this.store.state.settings.schedulerPollMs) || 15000);
    this.timer = setInterval(() => this.tick().catch(error => this.report('Scheduler error', error)), interval);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  report(title, error) {
    this.emit('automation-error', { title, message: error?.message || String(error) });
  }

  async tick() {
    const now = Date.now();
    const jobs = [];
    for (const server of [...this.store.state.servers]) {
      if (this.running.has(server.id)) continue;
      this.running.add(server.id);
      jobs.push((async () => {
        try {
          await this.handleBackup(server, now);
          await this.handleWipe(server, now);
          await this.handlePluginUpdates(server, now);
        } catch (error) {
          this.report(`Automation failed · ${server.name}`, error);
        } finally {
          this.running.delete(server.id);
        }
      })());
    }
    await Promise.allSettled(jobs);
  }

  async handleBackup(server, now) {
    const backup = server.schedules?.backup;
    if (!backup?.enabled) return;
    const interval = Math.max(1, Number(backup.intervalHours) || 24) * 60 * 60 * 1000;
    if (backup.lastAt && now - Number(backup.lastAt) < interval) return;
    await this.backups.create(server, { reason: 'scheduled', quiesce: Boolean(backup.safe) });
    backup.lastAt = Date.now();
    await this.store.save();
  }

  async handleWipe(server, now) {
    const wipe = server.schedules?.wipe;
    if (!wipe?.enabled) return;
    if (now < nextWipeTime(wipe.lastAt, wipe.frequency, wipe.hour, wipe.weekday).getTime()) return;
    await this.backups.wipe(server, {
      blueprintWipe: Boolean(wipe.blueprintWipe),
      forceBackup: Boolean(wipe.forceBackup)
    });
    wipe.lastAt = Date.now();
    await this.store.save();
  }

  async handlePluginUpdates(server, now) {
    if (!this.umod || !this.store.state.settings.autoPluginUpdates || server.uMod === false) return;
    const hours = Math.max(1, Number(this.store.state.settings.pluginUpdateCheckHours) || 6);
    const key = Number(server.pluginUpdateCheckedAt) || 0;
    if (key && now - key < hours * 60 * 60 * 1000) return;
    try {
      const results = await this.servers.withLifecycle(server.id, () => this.umod.updatePlugins(server));
      server.pluginUpdateCheckedAt = Date.now();
      await this.store.save();
      const updated = Array.isArray(results) ? results.filter(item => item.updated).length : 0;
      if (updated) this.emit('notification', {
        kind: 'success',
        title: 'Plugins updated',
        message: `${updated} plugin update(s) applied to ${server.name}.`
      });
    } catch (error) {
      server.pluginUpdateCheckedAt = Date.now();
      await this.store.save();
      this.report(`Plugin update failed · ${server.name}`, error);
    }
  }

  nextBackup(server) {
    const schedule = server.schedules?.backup;
    if (!schedule?.enabled) return null;
    if (!schedule.lastAt) return new Date(Date.now() + Math.max(1, Number(schedule.intervalHours) || 24) * 60 * 60 * 1000).toISOString();
    return new Date(Number(schedule.lastAt) + Math.max(1, Number(schedule.intervalHours) || 24) * 60 * 60 * 1000).toISOString();
  }

  nextWipe(server) {
    const schedule = server.schedules?.wipe;
    if (!schedule?.enabled) return null;
    return nextWipeTime(schedule.lastAt, schedule.frequency, schedule.hour, schedule.weekday).toISOString();
  }
}

module.exports = { Scheduler, nextWipeTime, DAY };

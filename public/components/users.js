import { Api } from '../lib/api.js';
import { MODULES } from '../lib/modules.js';

export default {
  data() {
    return { users: [], loading: true, savingUid: null, modules: MODULES, diag: null, diagHistory: [], diagLoading: false };
  },
  async mounted() {
    await this.reload();
  },
  methods: {
    async reload() {
      this.loading = true;
      try { this.users = await Api.get('/api/users'); } finally { this.loading = false; }
    },
    // Each click is one request. Keeping the last several side by side is the whole point:
    // if instanceId / hostname / pid differ between consecutive clicks, the host is either
    // restarting the app or running more than one copy of it -- which is exactly the kind
    // of thing that makes a save look like it "vanished" a moment later.
    async runDiag() {
      this.diagLoading = true;
      try {
        const d = await Api.get('/api/diag');
        this.diag = d;
        this.diagHistory.unshift({ at: d.now, instanceId: d.instanceId, hostname: d.hostname, pid: d.pid, uptime: d.uptimeSeconds, count: d.runsheetCount });
        if (this.diagHistory.length > 10) this.diagHistory.length = 10;
      } catch (e) { alert(e.message); } finally { this.diagLoading = false; }
    },
    async save(u) {
      this.savingUid = u.uid;
      try {
        await Api.put(`/api/users/${u.uid}`, { isAdmin: u.isAdmin, modules: u.modules });
      } catch (e) {
        alert(e.message);
        await this.reload(); // revert to server truth if the save was rejected (e.g. last-admin guard)
      } finally {
        this.savingUid = null;
      }
    },
  },
  template: `
  <div class="panel">
    <h1>Users &amp; Permissions</h1>
    <p class="hint" style="margin-top:-6px;">
      New sign-ins appear here automatically with no access — tick the pages each person should
      see, or make them an admin to grant everything (including managing this page itself).
      Changes save as soon as you change a checkbox.
    </p>

    <table v-if="!loading" style="margin-top:14px;">
      <thead><tr>
        <th style="text-align:left;">Person</th>
        <th class="center">Admin</th>
        <th v-for="m in modules" :key="m.key" class="center">{{ m.label }}</th>
      </tr></thead>
      <tbody>
        <tr v-for="u in users" :key="u.uid">
          <td>
            <div style="font-weight:500;">{{ u.displayName || u.email || u.uid }}</div>
            <div class="hint" v-if="u.displayName && u.email">{{ u.email }}</div>
          </td>
          <td class="center"><input type="checkbox" v-model="u.isAdmin" @change="save(u)" /></td>
          <td v-for="m in modules" :key="m.key" class="center">
            <input type="checkbox" v-model="u.modules[m.key]" :disabled="u.isAdmin" @change="save(u)" />
          </td>
        </tr>
        <tr v-if="!users.length"><td :colspan="modules.length + 2" class="empty">No one has signed in yet.</td></tr>
      </tbody>
    </table>
    <p class="hint" v-if="savingUid">Saving…</p>

    <h2 style="margin-top:32px;">Server Diagnostics</h2>
    <p class="hint" style="margin-top:-6px;">
      Reports facts from inside the running server. Click it several times in a row — if
      <b>Instance</b>, <b>Host</b>, or <b>PID</b> change between clicks, the server is restarting
      or running more than one copy of the app, which would explain saves appearing to vanish.
    </p>
    <button class="primary" @click="runDiag" :disabled="diagLoading">{{ diagLoading ? 'Checking…' : 'Run check' }}</button>

    <table v-if="diagHistory.length" style="margin-top:12px;">
      <thead><tr><th>Time</th><th>Instance</th><th>Host</th><th>PID</th><th>Uptime (s)</th><th>Runsheets</th></tr></thead>
      <tbody>
        <tr v-for="(h, i) in diagHistory" :key="i">
          <td class="mono">{{ h.at.slice(11, 19) }}</td>
          <td class="mono">{{ h.instanceId.slice(0, 8) }}</td>
          <td class="mono">{{ h.hostname }}</td>
          <td class="mono">{{ h.pid }}</td>
          <td class="mono">{{ h.uptime }}</td>
          <td class="mono">{{ h.count }}</td>
        </tr>
      </tbody>
    </table>

    <pre v-if="diag" style="margin-top:12px; font-size:11px; background:#f6f6f6; padding:10px; border-radius:6px; overflow:auto; max-height:420px;">{{ JSON.stringify(diag, null, 2) }}</pre>
  </div>
  `,
};

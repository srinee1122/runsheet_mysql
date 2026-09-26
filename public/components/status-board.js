// components/status-board.js — the Status board: where each runsheet is, and what happens
// to it after it's built. This page owns a runsheet's DISPATCH half — status, handover and
// return details, remarks and the activity log — and never its contents: stops, product
// lines and quantities are read-only here and only change in the Builder.
//
// Built for reception staff who aren't comfortable with computers: clicking a runsheet opens
// a drawer right under its row (no pop-up), a progress strip shows where it is, only the step
// that matters now is open, names and yes/no answers are big buttons to tap, counts have
// − / + buttons, dates and times have Today / Now, and every change saves by itself. Only the
// two real decisions are buttons: "Hand over to driver" and "Full / Partial delivery".
//
// What each person sees depends on the actions the super user granted them (see ACTIONS in
// lib/modules.js). The server enforces every one of them; hiding a button here is a
// convenience, not the protection.
import { Api } from '../lib/api.js';
import { formatDateTime } from '../lib/formatDate.js';
import { round2 } from '../lib/round2.js';

// Mirrors STATUS in server.js — the server is the authority; these only drive the screen.
const STATUS_LABEL = { draft: 'Draft', prepared: 'Prepared', pending: 'Pending Delivery', out: 'Out for Delivery', partial: 'Partial Delivery', delivered: 'Full Delivery', cancelled: 'Cancelled' };
const STATUS_RANK = { draft: 0, prepared: 1, pending: 2, out: 3, partial: 4, delivered: 4, cancelled: 99 };
const EVENT_LABEL = { create: 'Created', status: 'Status', status_back: 'Moved back', cancel: 'Cancelled', remark: 'Remark', dispatch: 'Details', handover: 'Handed over', outcome: 'Outcome recorded', super_edit: 'Edited after lock' };
const DISPATCH_EDITABLE = ['prepared', 'pending', 'out', 'partial', 'delivered'];
const BACK_EDITABLE = ['out', 'partial', 'delivered'];
const PAGE = 25;
const SAVE_DELAY = 700; // ms after the last change before it saves by itself

// Going out (Hand over permission) and coming back (Record delivery permission). Each has its
// own "entered by"; left empty, the server records whoever is logged in.
const blankForm = () => ({ v: 0,
  reception_date: '', delivery_date: '', del_man: '', vehicle_no: '', driver: '', company_id: null, time_in: '', time_out: '', pullers: [], crew: [], entered_by_out: '',
  received_date: '', invoices_all: '', missing_invoices: [], ri_not_delivered: '', ctn_not_delivered: '', pcs_not_delivered: '', has_returns: '', entered_by_back: '' });
const nowHHMM = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : ''; };

export default {
  inject: ['auth'],
  data() {
    return {
      runsheets: [], loading: true, search: '', statusFilter: 'active', shown: PAGE, pageMsg: '',
      products: [], staff: [], companies: [],
      // the open drawer
      openId: null, rs: null, form: blankForm(), savedForm: '', busy: false, msg: '',
      saveState: '', savedAt: '', conflict: false,
      remarks: [], events: [], newRemark: '',
      editOut: false, showInvoices: false, showRemarks: false, showLog: false, showMore: false,
      panel: '', backTo: '', reason: '',                 // More actions: '' | 'back' | 'cancel'
      other: { driver: false, del_man: false, pullers: '', crew: '' }, // "Other name" inputs
      changeCompany: false, changeWho: { out: false, back: false },
      errors: [],                                        // fields to fix before handing over
      STATUS_LABEL, EVENT_LABEL,
      // Drafts are still the office's work in progress: they live in the Builder and History
      // only, and appear here once marked Prepared.
      FILTER_STATUSES: Object.keys(STATUS_LABEL).filter(k => k !== 'draft'),
    };
  },
  computed: {
    can() { return (this.auth.permissions && this.auth.permissions.actions) || {}; },
    canBuilder() { return !!(this.auth.permissions && this.auth.permissions.modules.builder); },
    filtered() {
      const q = this.search.trim().toLowerCase(), f = this.statusFilter;
      return this.runsheets.filter(r => {
        const st = r.status || 'draft';
        if (st === 'draft') return false;   // never on the board, whatever the filter
        if (f === 'active' && (st === 'delivered' || st === 'cancelled')) return false;
        if (f !== 'active' && f !== 'all' && st !== f) return false;
        if (!q) return true;
        const d = r.dispatch || {};
        return [r.sheet_no, r.area, r.delivery_man, r.vehicle_no, d.del_man, d.vehicle_no, d.driver, d.company_name]
          .some(v => String(v || '').toLowerCase().includes(q));
      });
    },
    visible() { return this.filtered.slice(0, this.shown); },
    // ---- the open drawer ----
    status() { return this.rs ? (this.rs.status || 'draft') : ''; },
    // the progress strip: Office -> Reception -> With driver -> Done
    step() { return { prepared: 0, pending: 1, out: 2, partial: 3, delivered: 3 }[this.status] ?? -1; },
    outEditable() { return this.can.handover && DISPATCH_EDITABLE.includes(this.status); },
    backVisible() { return BACK_EDITABLE.includes(this.status); },
    backEditable() { return this.can.deliver && BACK_EDITABLE.includes(this.status); },
    anyEditable() { return this.outEditable || this.backEditable; },
    // "Going out" is open while it's the current step (or on Edit); afterwards it's a summary
    outOpen() { return this.editOut || this.status === 'prepared' || this.status === 'pending'; },
    canHandOver() { return this.status === 'pending' && this.can.handover; },
    me() {
      const p = this.auth.permissions || {}, s = String(p.displayName || p.email || '').trim();
      const n = s.includes('@') ? s.slice(0, s.indexOf('@')) : s;
      return n.charAt(0).toUpperCase() + n.slice(1);
    },
    dirty() { return JSON.stringify(this.form) !== this.savedForm; },
    staffFor() {
      const by = (role) => this.staff.filter(p => p.active && p.roles[role]).map(p => p.name);
      return { driver: by('driver'), del_man: by('del_man'), pullers: by('puller'), crew: by('crew') };
    },
    everyone() { return this.staff.filter(p => p.active).map(p => p.name); },
    companyOptions() { return this.companies.filter(c => c.active || c.id === this.form.company_id); },
    backTargets() {
      if (this.status === 'cancelled') return ['draft', 'prepared', 'pending', 'out'];
      return Object.keys(STATUS_RANK).filter(st => st !== 'cancelled' && st !== 'partial' && STATUS_RANK[st] < STATUS_RANK[this.status]);
    },
    invoices() {
      if (!this.rs) return [];
      const byId = new Map(this.products.map(p => [p.id, p]));
      return ((this.rs.data && this.rs.data.stops) || []).map((s, i) => {
        let ri = 0, pcs = 0;
        for (const it of s.round_items || []) {
          const q = Number(it.qty_ctn) || 0;
          if (it.packing_type === 'pcs') pcs += q * (((byId.get(it.product_id) || {}).qty_per_ctn) || 1);
          else ri += q;
        }
        return { sn: i + 1, inv: s.invoice_no || '', so: s.so_no || '', cust: s.customer || '',
          ctns: round2((Number(s.ctns_carton) || 0) + (Number(s.ctns_bag) || 0)), ri: round2(ri), pcs: round2(pcs) };
      });
    },
    totals() {
      const t = { ctns: 0, ri: 0, pcs: 0 };
      for (const r of this.invoices) { t.ctns += r.ctns; t.ri += r.ri; t.pcs += r.pcs; }
      return { ctns: round2(t.ctns), ri: round2(t.ri), pcs: round2(t.pcs) };
    },
    shortages() {
      const f = this.form, out = [];
      if (Number(f.ri_not_delivered) > 0) out.push(`${f.ri_not_delivered} round item(s)`);
      if (Number(f.ctn_not_delivered) > 0) out.push(`${f.ctn_not_delivered} carton(s)`);
      if (Number(f.pcs_not_delivered) > 0) out.push(`${f.pcs_not_delivered} piece(s)`);
      if (f.missing_invoices.length) out.push(`${f.missing_invoices.length} missing invoice(s)`);
      if (f.has_returns === 'yes') out.push('return goods');
      return out;
    },
    suggestedOutcome() { return this.shortages.length ? 'partial' : 'delivered'; },
    outSummary() {
      const f = this.form;
      return [f.reception_date && `At reception ${shortDate(f.reception_date)}`, f.delivery_date && `Delivery ${shortDate(f.delivery_date)}`,
        f.driver && `Driver ${f.driver}${this.companyName(f.company_id) ? ' · ' + this.companyName(f.company_id) : ''}`,
        f.vehicle_no && `Vehicle ${f.vehicle_no}`, f.time_out && `Left ${f.time_out}`].filter(Boolean).join('   ·   ');
    },
  },
  watch: {
    search() { this.shown = PAGE; },
    statusFilter() { this.shown = PAGE; },
    // every change saves by itself, a moment after the last keystroke or tap
    form: { deep: true, handler() { this.queueSave(); } },
    // a link to /status?open=<id> followed while already on the board still opens it
    '$route.query.open'(v) { if (v && this.openId !== Number(v)) this.openRunsheet(Number(v)); },
  },
  async mounted() {
    // Keep the list current while reception has the board open: office marks runsheets
    // Pending elsewhere. Refresh when the tab comes back into view, and every minute while
    // it's visible. (An open drawer is left alone.)
    this._onVisible = () => { if (document.visibilityState === 'visible') this.reload(true); };
    document.addEventListener('visibilitychange', this._onVisible);
    window.addEventListener('focus', this._onVisible);
    this._timer = setInterval(() => { if (document.visibilityState === 'visible') this.reload(true); }, 60000);
    await this.reload();
    try { this.products = await Api.get('/api/products'); } catch { this.products = []; }
    try { this.staff = await Api.get('/api/staff'); } catch { this.staff = []; }
    try { this.companies = await Api.get('/api/companies'); } catch { this.companies = []; }
    const open = this.$route && this.$route.query.open;
    if (open) this.openRunsheet(Number(open));
  },
  beforeUnmount() {
    document.removeEventListener('visibilitychange', this._onVisible);
    window.removeEventListener('focus', this._onVisible);
    clearInterval(this._timer);
    clearTimeout(this._saveTimer);
  },
  methods: {
    formatDateTime, round2, nowHHMM, todayISO, shortDate,
    // quiet = a background refresh: no "Loading…" flash, and a failed one is simply skipped
    async reload(quiet) {
      if (!quiet) this.loading = true;
      try { this.runsheets = await Api.get('/api/runsheets'); }
      catch (e) { if (!quiet) throw e; }
      finally { this.loading = false; }
    },

    // ---- table cells ----
    driverCell(r) { const d = r.dispatch || {}; return [d.driver, d.company_name].filter(Boolean).join(' · '); },
    invoicesCell(r) { const d = r.dispatch || {}; return d.invoices_all === 'yes' ? 'All' : d.invoices_all === 'no' ? `${(d.missing_invoices || []).length} missing` : ''; },
    notDeliveredCell(r) {
      const d = r.dispatch || {}, parts = [];
      // non-breaking inside each figure, so a narrow screen wraps between figures, never within one
      if (d.ri_not_delivered !== '' && d.ri_not_delivered != null) parts.push('RI\u00a0' + d.ri_not_delivered);
      if (d.ctn_not_delivered !== '' && d.ctn_not_delivered != null) parts.push('CTN\u00a0' + d.ctn_not_delivered);
      if (Number(d.pcs_not_delivered) > 0) parts.push(d.pcs_not_delivered + '\u00a0pcs');
      return parts.join(' · ');
    },
    // what reception should do next, shown under the status in the table
    nextHint(r) {
      const st = r.status || 'draft';
      if (st === 'prepared') return 'Office still preparing';
      if (st === 'pending') return this.can.handover ? 'Next: hand over' : '';
      if (st === 'out') return this.can.deliver ? 'Next: record return' : '';
      return '';
    },

    // ---- opening / closing the drawer ----
    async toggle(id) {
      if (this.openId === id) return this.closeDrawer();
      await this.openRunsheet(id);
    },
    async openRunsheet(id) {
      await this.flush();
      this.msg = ''; this.panel = ''; this.reason = ''; this.newRemark = ''; this.errors = [];
      this.editOut = false; this.showInvoices = false; this.showRemarks = false; this.showLog = false; this.showMore = false;
      this.changeCompany = false; this.changeWho = { out: false, back: false };
      this.other = { driver: false, del_man: false, pullers: '', crew: '' };
      this.saveState = ''; this.conflict = false;
      try {
        const rs = await Api.get(`/api/runsheets/${id}`);
        if ((rs.status || 'draft') === 'draft') {
          this.rs = null; this.openId = null;
          this.pageMsg = `Runsheet ${rs.sheet_no || '#' + rs.id} is still a Draft, so it isn't on the Status board. It appears here once it's marked Prepared in the Builder.`;
          return;
        }
        this.loadForm(rs);
        this.openId = rs.id;
        await this.loadNotes();
        this.$nextTick(() => {
          const el = document.querySelector(`[data-rs="${rs.id}"]`);
          if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      } catch (e) { alert(e.message); this.rs = null; this.openId = null; }
    },
    loadForm(rs) {
      this.rs = rs;
      const d = rs.dispatch || blankForm();
      // the planned delivery man / vehicle / delivery date from the Builder pre-fill the actual ones
      const f = { ...blankForm(), ...d, del_man: d.del_man || rs.delivery_man || '', vehicle_no: d.vehicle_no || rs.vehicle_no || '',
        delivery_date: d.delivery_date || rs.delivery_date || '',
        pullers: [...(d.pullers || [])], crew: [...(d.crew || [])], missing_invoices: [...(d.missing_invoices || [])] };
      for (const k of ['ri_not_delivered', 'ctn_not_delivered', 'pcs_not_delivered']) f[k] = d[k] === '' || d[k] == null ? '' : d[k];
      // the watcher mustn't treat loading as a change: savedForm is set before it can fire
      this.savedForm = JSON.stringify(f);
      this.form = f;
    },
    async loadNotes() {
      const id = this.rs.id;
      this.remarks = (this.can.remarks || this.can.view_log) ? await Api.get(`/api/runsheets/${id}/remarks`).catch(() => []) : [];
      this.events = this.can.view_log ? await Api.get(`/api/runsheets/${id}/events`).catch(() => []) : [];
    },
    async closeDrawer() {
      await this.flush();
      this.openId = null; this.rs = null;
      if (this.$route && this.$route.query.open) this.$router.replace({ path: '/status' });
    },
    // after a status change: refresh the list, then the drawer (or close it if it left the board)
    async afterChange(message) {
      const id = this.rs.id, label = this.rs.sheet_no || '#' + id;
      await this.reload(true);
      const now = this.runsheets.find(r => r.id === id);
      if (now && (now.status || 'draft') === 'draft') {
        this.openId = null; this.rs = null;
        this.pageMsg = `Runsheet ${label} was moved back to Draft. It's now in the Builder and History only, and returns here once it's marked Prepared again.`;
        if (this.$route && this.$route.query.open) this.$router.replace({ path: '/status' });
        return;
      }
      const rs = await Api.get(`/api/runsheets/${id}`);
      this.loadForm(rs);
      this.editOut = false;
      await this.loadNotes();
      this.msg = message;
    },

    // ---- saving by itself ----
    queueSave() {
      if (!this.rs || !this.anyEditable || this.conflict || !this.dirty) return;
      clearTimeout(this._saveTimer);
      this.saveState = 'waiting';
      this._saveTimer = setTimeout(() => this.saveNow(), SAVE_DELAY);
    },
    async saveNow() {
      clearTimeout(this._saveTimer);
      if (this._inflight) await this._inflight;   // one save at a time, always with the latest version
      if (!this.rs || !this.dirty || this.conflict) { if (this.saveState === 'waiting') this.saveState = ''; return; }
      const payload = JSON.parse(JSON.stringify(this.form));
      const id = this.rs.id;
      this.saveState = 'saving';
      this._inflight = (async () => {
        try {
          const r = await Api.put(`/api/runsheets/${id}/dispatch`, payload);
          if (!this.rs || this.rs.id !== id) return;
          const newV = r.dispatch.v;
          this.savedForm = JSON.stringify({ ...payload, v: newV });
          this.form.v = newV;                      // keep any typing done meanwhile; it saves next
          this.rs.dispatch = r.dispatch;
          const row = this.runsheets.find(x => x.id === id);
          if (row) row.dispatch = r.dispatch;       // the table row updates as you type
          this.saveState = 'saved'; this.savedAt = nowHHMM();
        } catch (e) {
          this.saveState = 'error';
          if (e.status === 409) this.conflict = true;
          else this.msg = 'Could not save: ' + e.message;
        } finally { this._inflight = null; }
      })();
      await this._inflight;
    },
    // make sure everything typed has reached the server (before an action, or closing)
    async flush() {
      clearTimeout(this._saveTimer);
      if (this._inflight) await this._inflight;
      if (this.rs && this.dirty && this.anyEditable && !this.conflict) await this.saveNow();
    },
    async reloadAfterConflict() {
      const id = this.rs.id; this.conflict = false;
      await this.reload(true);
      const rs = await Api.get(`/api/runsheets/${id}`);
      this.loadForm(rs); this.saveState = ''; this.msg = 'Reloaded with the latest details.';
    },

    // ---- tapping names ----
    // Tapping a name selects it; tapping it again keeps it selected (someone tapping twice
    // "to be sure" mustn't clear it). Clearing is a separate, deliberate "clear" link.
    pick(field, name) {
      this.form[field] = name;
      if (field === 'driver') this.onDriver();
      this.other[field] = false;
    },
    clearPick(field) {
      this.form[field] = '';
      if (field === 'driver') this.form.company_id = null;
      this.other[field] = false;
    },
    togglePerson(list, name) {
      const i = this.form[list].indexOf(name);
      if (i >= 0) this.form[list].splice(i, 1); else this.form[list].push(name);
    },
    addOther(list) {
      const name = String(this.other[list] || '').trim();
      if (name && !this.form[list].includes(name)) this.form[list].push(name);
      this.other[list] = '';
    },
    // picking a driver fills in their company (still changeable for a one-off)
    onDriver() {
      const p = this.staff.find(x => x.name.toLowerCase() === String(this.form.driver || '').trim().toLowerCase());
      if (p && p.company_id) this.form.company_id = p.company_id;
    },
    companyName(id) { const c = this.companies.find(x => x.id === id); return c ? c.name : ''; },
    bump(field, delta) {
      const v = Math.max(0, round2((Number(this.form[field]) || 0) + delta));
      this.form[field] = v;
    },
    toggleMissing(inv) {
      const i = this.form.missing_invoices.indexOf(inv);
      if (i >= 0) this.form.missing_invoices.splice(i, 1); else this.form.missing_invoices.push(inv);
    },

    // ---- the two big actions ----
    async handOver() {
      this.errors = [];
      if (!this.form.del_man.trim()) this.errors.push('del_man');
      if (!this.form.vehicle_no.trim()) this.errors.push('vehicle_no');
      if (this.errors.length) { this.msg = 'Please fill in the boxes marked in red first.'; return; }
      if (!this.form.time_out) this.form.time_out = nowHHMM();
      if (!confirm(`Hand over runsheet ${this.rs.sheet_no || '#' + this.rs.id} to ${this.form.driver || this.form.del_man} (${this.form.vehicle_no}) at ${this.form.time_out}?\n\nAfter this, the runsheet's items can't be changed.`)) return;
      this.busy = true;
      try {
        await this.flush();
        await Api.post(`/api/runsheets/${this.rs.id}/handover`, this.form);
        await this.afterChange('Handed over to the driver. When the runsheet comes back, fill in "Coming back" below.');
      } catch (e) { alert(e.message); } finally { this.busy = false; }
    },
    async record(outcome) {
      if (outcome === 'delivered' && this.shortages.length &&
        !confirm(`You entered ${this.shortages.join(', ')}.\n\nRecord this as FULL delivery anyway?`)) return;
      if (outcome === 'partial' && !this.shortages.length &&
        !confirm('Nothing is marked as not delivered or missing.\n\nRecord this as PARTIAL delivery anyway?')) return;
      this.busy = true;
      try {
        await this.flush();
        await Api.post(`/api/runsheets/${this.rs.id}/outcome`, { ...this.form, outcome });
        await this.afterChange(`Recorded as ${STATUS_LABEL[outcome]}.`);
      } catch (e) { alert(e.message); } finally { this.busy = false; }
    },

    // ---- less common actions ----
    async markPending() {
      if (!confirm('Mark this runsheet as Pending Delivery (ready to hand over)?')) return;
      await this.setStatus('pending', '', 'Now Pending Delivery.');
    },
    async confirmBack() {
      if (!this.reason.trim()) { this.msg = 'Please write a reason.'; return; }
      await this.setStatus(this.backTo, this.reason.trim(), `Moved back to ${STATUS_LABEL[this.backTo]}.`);
    },
    async confirmCancel() {
      if (!this.reason.trim()) { this.msg = 'Please write a reason.'; return; }
      await this.setStatus('cancelled', this.reason.trim(), 'Runsheet cancelled.');
    },
    async setStatus(to, reason, message) {
      this.busy = true;
      try {
        await this.flush();
        await Api.post(`/api/runsheets/${this.rs.id}/status`, { to, reason });
        this.panel = ''; this.reason = ''; this.showMore = false;
        await this.afterChange(message);
      } catch (e) { alert(e.message); } finally { this.busy = false; }
    },
    openMore(which) {
      this.panel = this.panel === which ? '' : which; this.reason = '';
      if (which === 'back') this.backTo = this.backTargets[this.backTargets.length - 1] || '';
    },
    async addRemark() {
      const note = this.newRemark.trim();
      if (!note) return;
      this.busy = true;
      try {
        await Api.post(`/api/runsheets/${this.rs.id}/remarks`, { note });
        this.newRemark = '';
        await this.loadNotes();
      } catch (e) { alert(e.message); } finally { this.busy = false; }
    },
    eventText(e) {
      if (e.type === 'status' || e.type === 'status_back' || e.type === 'cancel' || e.type === 'handover' || e.type === 'outcome') {
        const move = `${STATUS_LABEL[e.from_status] || e.from_status || '—'} → ${STATUS_LABEL[e.to_status] || e.to_status}`;
        return [move, e.reason, e.note].filter(Boolean).join(' · ');
      }
      return e.note || e.reason || '';
    },
  },
  template: `
  <div class="page-head">
    <div><h1>Status board</h1><div class="sub">Click a runsheet to open it. Everything you enter saves by itself.</div></div>
  </div>

  <div class="panel">
    <div class="sb-filters">
      <input type="text" v-model="search" placeholder="Search sheet no, driver, vehicle…" />
      <select v-model="statusFilter">
        <option value="active">Active (not delivered / cancelled)</option>
        <option value="all">All (except drafts)</option>
        <option v-for="key in FILTER_STATUSES" :key="key" :value="key">{{ STATUS_LABEL[key] }}</option>
      </select>
      <button class="small" @click="reload()" :disabled="loading" title="Updates on its own every minute too">Refresh</button>
    </div>
    <div class="sb-msg" v-if="pageMsg" @click="pageMsg = ''" title="Click to dismiss">{{ pageMsg }}</div>

    <p class="hint" v-if="loading">Loading…</p>
    <table v-else class="sb-table">
      <thead><tr>
        <th>Sheet No</th><th>Status</th><th>To reception</th><th>Delivery date</th><th>Driver</th>
        <th class="center">RI / CTN</th><th>Back</th><th>Invoices</th><th>Not delivered</th><th>Returns</th>
      </tr></thead>
      <tbody>
        <template v-for="r in visible" :key="r.id">
          <tr class="sb-row" :class="{ open: openId === r.id }" :data-rs="r.id" tabindex="0" @click="toggle(r.id)" @keydown.enter="toggle(r.id)">
            <td class="mono nowrap"><span class="sb-caret">{{ openId === r.id ? '▾' : '▸' }}</span> {{ r.sheet_no || '—' }}</td>
            <td><span :class="'status-badge status-' + (r.status || 'draft')">{{ STATUS_LABEL[r.status || 'draft'] }}</span>
              <div class="sb-next" v-if="nextHint(r)">{{ nextHint(r) }}</div></td>
            <td class="nowrap">{{ shortDate(r.dispatch && r.dispatch.reception_date) || '—' }}</td>
            <td class="nowrap" :class="{ planned: !(r.dispatch && r.dispatch.delivery_date) }">{{ shortDate((r.dispatch && r.dispatch.delivery_date) || r.delivery_date) || '—' }}</td>
            <td>{{ driverCell(r) || '—' }}</td>
            <td class="center mono">{{ r.totals.ri }}&nbsp;/&nbsp;{{ r.totals.ctns }}<span class="pcs-add" v-if="r.totals.pcs"> +{{ r.totals.pcs }}&nbsp;pcs</span></td>
            <td class="nowrap">{{ shortDate(r.dispatch && r.dispatch.received_date) || '—' }}</td>
            <td class="nowrap" :class="{ warnish: r.dispatch && r.dispatch.invoices_all === 'no' }">{{ invoicesCell(r) || '—' }}</td>
            <td :class="{ warnish: notDeliveredCell(r) }">{{ notDeliveredCell(r) || '—' }}</td>
            <td>{{ r.dispatch && r.dispatch.has_returns === 'yes' ? 'Yes' : r.dispatch && r.dispatch.has_returns === 'no' ? 'No' : '—' }}</td>
          </tr>

          <!-- ===================== the drawer ===================== -->
          <tr v-if="openId === r.id && rs" class="sb-drawer-row"><td colspan="10">
          <div class="dr">
            <div class="dr-top">
              <div class="dr-title">Runsheet {{ rs.sheet_no || '#' + rs.id }}
                <span class="dr-sub">{{ invoices.length }} shop(s) · Round items {{ totals.ri }} · Cartons {{ totals.ctns }}<span v-if="totals.pcs"> · {{ totals.pcs }} loose pieces</span></span></div>
              <div class="dr-savestate" v-if="anyEditable">
                <span v-if="saveState === 'saving' || saveState === 'waiting'">Saving…</span>
                <span v-else-if="saveState === 'saved'" class="ok">✓ Saved {{ savedAt }}</span>
                <span v-else-if="saveState === 'error' && !conflict" class="bad">Not saved</span>
              </div>
              <button class="dr-close" @click.stop="closeDrawer" title="Close">Close ✕</button>
            </div>

            <!-- progress strip -->
            <ol class="dr-steps" v-if="status !== 'cancelled'">
              <li v-for="(label, i) in ['Office', 'Reception', 'With driver', status === 'partial' ? 'Done: Partial' : status === 'delivered' ? 'Done: Full' : 'Done']" :key="i"
                :class="{ done: i < step, now: i === step }"><span class="dot">{{ i < step ? '✓' : i + 1 }}</span>{{ label }}</li>
            </ol>
            <div class="dr-banner bad" v-else>This runsheet was cancelled.</div>

            <div class="dr-msg" v-if="msg" @click="msg = ''">{{ msg }}</div>
            <div class="dr-msg bad" v-if="conflict">Someone else changed this runsheet just now. <button class="small" @click="reloadAfterConflict">Load the latest</button></div>

            <!-- ============ 1. GOING OUT ============ -->
            <section class="dr-card" :class="{ current: status === 'pending' || status === 'prepared' }">
              <div class="dr-card-head">
                <span class="dr-num">1</span> Going out
                <span class="dr-ro" v-if="!outEditable">(view only)</span>
                <button class="small ghost" v-if="!outOpen" @click="editOut = true">{{ outEditable ? 'Edit' : 'Show' }}</button>
                <button class="small ghost" v-if="outOpen && editOut" @click="editOut = false">Done editing</button>
              </div>
              <div class="dr-summary" v-if="!outOpen">{{ outSummary || 'Nothing entered.' }}</div>

              <fieldset class="lockable" v-if="outOpen" :disabled="!outEditable || busy">
                <div class="dr-note" v-if="status === 'prepared'">The office hasn't marked this runsheet ready yet. You can already fill in details.
                  <button class="small" v-if="can.prepare" @click="markPending">Mark it ready (Pending Delivery)</button></div>

                <div class="dr-row">
                  <div class="dr-field"><label>Received from office</label>
                    <div class="dr-inline"><input type="date" v-model="form.reception_date" /><button type="button" class="dr-quick" @click="form.reception_date = todayISO()">Today</button></div></div>
                  <div class="dr-field"><label>Delivery date</label>
                    <div class="dr-inline"><input type="date" v-model="form.delivery_date" /><button type="button" class="dr-quick" @click="form.delivery_date = todayISO()">Today</button></div>
                    <div class="dr-hint" v-if="rs.delivery_date && rs.delivery_date !== form.delivery_date">Office planned {{ shortDate(rs.delivery_date) }}</div></div>
                </div>

                <div class="dr-field"><label>Driver <a href="#" class="dr-clear" v-if="form.driver && outEditable" @click.prevent="clearPick('driver')">clear</a></label>
                  <div class="dr-chips">
                    <button type="button" v-for="n in staffFor.driver" :key="n" class="dr-chip" :class="{ on: form.driver === n }" @click="pick('driver', n)">{{ n }}</button>
                    <button type="button" class="dr-chip other" :class="{ on: other.driver || (form.driver && !staffFor.driver.includes(form.driver)) }" @click="other.driver = true">Other name…</button>
                  </div>
                  <input v-if="other.driver || (form.driver && !staffFor.driver.includes(form.driver)) || !staffFor.driver.length" type="text" v-model="form.driver" @change="onDriver" placeholder="Type the driver's name" class="dr-other" />
                  <div class="dr-hint" v-if="form.driver">
                    Company: <b>{{ companyName(form.company_id) || 'none' }}</b>
                    <a href="#" @click.prevent="changeCompany = !changeCompany">change</a>
                    <select v-if="changeCompany" v-model="form.company_id" class="dr-select"><option :value="null">— none —</option>
                      <option v-for="c in companyOptions" :key="c.id" :value="c.id">{{ c.name }} ({{ c.kind === 'inhouse' ? 'in-house' : 'third-party' }})</option></select>
                  </div></div>

                <div class="dr-field" :class="{ err: errors.includes('del_man') }"><label>Delivery man <a href="#" class="dr-clear" v-if="form.del_man && outEditable" @click.prevent="clearPick('del_man')">clear</a></label>
                  <div class="dr-chips">
                    <button type="button" v-for="n in staffFor.del_man" :key="n" class="dr-chip" :class="{ on: form.del_man === n }" @click="pick('del_man', n)">{{ n }}</button>
                    <button type="button" class="dr-chip other" :class="{ on: other.del_man || (form.del_man && !staffFor.del_man.includes(form.del_man)) }" @click="other.del_man = true">Other name…</button>
                  </div>
                  <input v-if="other.del_man || (form.del_man && !staffFor.del_man.includes(form.del_man)) || !staffFor.del_man.length" type="text" v-model="form.del_man" placeholder="Type the delivery man's name" class="dr-other" />
                  <div class="dr-hint" v-if="rs.delivery_man && rs.delivery_man !== form.del_man">Office planned {{ rs.delivery_man }}</div></div>

                <div class="dr-row">
                  <div class="dr-field" :class="{ err: errors.includes('vehicle_no') }"><label>Vehicle number</label><input type="text" v-model="form.vehicle_no" placeholder="e.g. GBB1234K" />
                    <div class="dr-hint" v-if="rs.vehicle_no && rs.vehicle_no !== form.vehicle_no">Office planned {{ rs.vehicle_no }}</div></div>
                  <div class="dr-field"><label>Van arrived to load</label>
                    <div class="dr-inline"><input type="time" v-model="form.time_in" /><button type="button" class="dr-quick" @click="form.time_in = nowHHMM()">Now</button></div></div>
                  <div class="dr-field"><label>Van left</label>
                    <div class="dr-inline"><input type="time" v-model="form.time_out" /><button type="button" class="dr-quick" @click="form.time_out = nowHHMM()">Now</button></div>
                    <div class="dr-hint" v-if="status === 'pending' && !form.time_out">Filled in when you hand over.</div></div>
                </div>

                <div class="dr-row">
                  <div class="dr-field" v-for="grp in [{ key: 'pullers', label: 'Puller(s)' }, { key: 'crew', label: 'Loading crew' }]" :key="grp.key"><label>{{ grp.label }} <span class="dr-hint">— tap everyone who helped</span></label>
                    <div class="dr-chips">
                      <button type="button" v-for="n in staffFor[grp.key]" :key="n" class="dr-chip" :class="{ on: form[grp.key].includes(n) }" @click="togglePerson(grp.key, n)">{{ form[grp.key].includes(n) ? '✓ ' : '' }}{{ n }}</button>
                      <button type="button" v-for="n in form[grp.key].filter(x => !staffFor[grp.key].includes(x))" :key="'x' + n" class="dr-chip on" @click="togglePerson(grp.key, n)">✓ {{ n }}</button>
                    </div>
                    <div class="dr-inline"><input type="text" v-model="other[grp.key]" placeholder="Other name" @keydown.enter.prevent="addOther(grp.key)" class="dr-other" /><button type="button" class="dr-quick" @click="addOther(grp.key)">Add</button></div>
                  </div>
                </div>

                <div class="dr-who">Entered by
                  <b>{{ form.entered_by_out || (outEditable ? me + ' (you)' : '—') }}</b>
                  <a href="#" v-if="outEditable" @click.prevent="changeWho.out = !changeWho.out">not you?</a>
                  <span class="dr-chips inline" v-if="changeWho.out">
                    <button type="button" v-for="n in everyone" :key="n" class="dr-chip small" :class="{ on: form.entered_by_out === n }" @click="form.entered_by_out = n; changeWho.out = false">{{ n }}</button>
                    <input type="text" v-model="form.entered_by_out" placeholder="or type a name" class="dr-other" />
                  </span>
                </div>
              </fieldset>

              <div class="dr-action" v-if="canHandOver && outOpen">
                <button class="dr-big primary" @click="handOver" :disabled="busy">✓ Hand over to driver</button>
                <span class="dr-hint">Press this when the van leaves. The runsheet becomes "Out for Delivery".</span>
              </div>
            </section>

            <!-- ============ 2. COMING BACK ============ -->
            <section class="dr-card" :class="{ current: status === 'out' }" v-if="backVisible">
              <div class="dr-card-head"><span class="dr-num">2</span> Coming back <span class="dr-ro" v-if="!backEditable">(view only)</span></div>
              <fieldset class="lockable" :disabled="!backEditable || busy">
                <div class="dr-row">
                  <div class="dr-field"><label>Runsheet came back on</label>
                    <div class="dr-inline"><input type="date" v-model="form.received_date" /><button type="button" class="dr-quick" @click="form.received_date = todayISO()">Today</button></div></div>
                  <div class="dr-field"><label>All invoices came back?</label>
                    <div class="dr-yn"><button type="button" :class="{ on: form.invoices_all === 'yes' }" @click="form.invoices_all = 'yes'">Yes</button>
                      <button type="button" :class="{ on: form.invoices_all === 'no', no: true }" @click="form.invoices_all = 'no'">No</button></div></div>
                  <div class="dr-field"><label>Any return goods?</label>
                    <div class="dr-yn"><button type="button" :class="{ on: form.has_returns === 'yes', no: true }" @click="form.has_returns = 'yes'">Yes</button>
                      <button type="button" :class="{ on: form.has_returns === 'no' }" @click="form.has_returns = 'no'">No</button></div></div>
                </div>

                <div class="dr-field" v-if="form.invoices_all === 'no'"><label>Tap the invoices that did NOT come back</label>
                  <div class="dr-chips">
                    <button type="button" v-for="r in invoices.filter(x => x.inv)" :key="r.sn" class="dr-chip" :class="{ on: form.missing_invoices.includes(r.inv), warn: form.missing_invoices.includes(r.inv) }" @click="toggleMissing(r.inv)">
                      {{ form.missing_invoices.includes(r.inv) ? '✗ ' : '' }}{{ r.inv }} <span class="dr-chip-sub">{{ r.cust }}</span></button>
                  </div></div>

                <div class="dr-row">
                  <div class="dr-field" v-for="c in [{ key: 'ri_not_delivered', label: 'Round items NOT delivered', unit: 'cartons' }, { key: 'ctn_not_delivered', label: 'Cartons NOT delivered', unit: 'cartons' }].concat(totals.pcs || Number(form.pcs_not_delivered) > 0 ? [{ key: 'pcs_not_delivered', label: 'Loose pieces NOT delivered', unit: 'pieces' }] : [])" :key="c.key">
                    <label>{{ c.label }}</label>
                    <div class="dr-count"><button type="button" @click="bump(c.key, -1)">−</button>
                      <input type="number" min="0" step="any" v-model="form[c.key]" placeholder="0" />
                      <button type="button" @click="bump(c.key, 1)">+</button><span class="dr-hint">{{ c.unit }}</span></div></div>
                </div>

                <div class="dr-who">Entered by
                  <b>{{ form.entered_by_back || (backEditable ? me + ' (you)' : '—') }}</b>
                  <a href="#" v-if="backEditable" @click.prevent="changeWho.back = !changeWho.back">not you?</a>
                  <span class="dr-chips inline" v-if="changeWho.back">
                    <button type="button" v-for="n in everyone" :key="n" class="dr-chip small" :class="{ on: form.entered_by_back === n }" @click="form.entered_by_back = n; changeWho.back = false">{{ n }}</button>
                    <input type="text" v-model="form.entered_by_back" placeholder="or type a name" class="dr-other" />
                  </span>
                </div>
              </fieldset>

              <div class="dr-action" v-if="backEditable">
                <div class="dr-outcome-q">{{ status === 'out' ? 'How did the delivery go?' : 'Recorded as ' + STATUS_LABEL[status] + '. Change it?' }}</div>
                <button class="dr-big" :class="{ primary: suggestedOutcome === 'delivered', current: status === 'delivered' }" @click="record('delivered')" :disabled="busy">✓ Everything delivered — Full</button>
                <button class="dr-big" :class="{ primary: suggestedOutcome === 'partial', warn: true, current: status === 'partial' }" @click="record('partial')" :disabled="busy">Some not delivered — Partial</button>
                <span class="dr-hint" v-if="shortages.length">You entered {{ shortages.join(', ') }}.</span>
              </div>
            </section>

            <!-- ============ tucked away ============ -->
            <div class="dr-links">
              <a href="#" @click.prevent="showInvoices = !showInvoices">{{ showInvoices ? '▾' : '▸' }} The {{ invoices.length }} invoice(s) on this runsheet</a>
              <a href="#" v-if="can.remarks || can.view_log" @click.prevent="showRemarks = !showRemarks">{{ showRemarks ? '▾' : '▸' }} Remarks ({{ remarks.length }})</a>
              <a href="#" v-if="can.view_log" @click.prevent="showLog = !showLog">{{ showLog ? '▾' : '▸' }} History of this runsheet</a>
              <a href="#" v-if="can.move_back" @click.prevent="showMore = !showMore">{{ showMore ? '▾' : '▸' }} More actions</a>
              <router-link v-if="canBuilder" :to="'/builder/' + rs.id">Open in Builder →</router-link>
            </div>

            <div class="dr-box" v-if="showInvoices">
              <table class="sb-inv">
                <thead><tr><th class="center">#</th><th>Invoice</th><th>Shop</th><th class="center">Cartons</th><th class="center">Round items</th><th class="center">Loose pcs</th></tr></thead>
                <tbody><tr v-for="r in invoices" :key="r.sn"><td class="center mono">{{ r.sn }}</td><td class="mono">{{ r.inv || '—' }}</td><td>{{ r.cust || '—' }}</td>
                  <td class="center mono">{{ r.ctns || '·' }}</td><td class="center mono">{{ r.ri || '·' }}</td><td class="center mono">{{ r.pcs || '·' }}</td></tr></tbody>
              </table>
            </div>

            <div class="dr-box" v-if="showRemarks && (can.remarks || can.view_log)">
              <ul class="sb-remarks">
                <li v-for="x in remarks" :key="x.id"><span class="dr-hint">{{ formatDateTime(x.at) }} · {{ x.actor_name }}</span><div>{{ x.note }}</div></li>
                <li v-if="!remarks.length" class="dr-hint">No remarks yet.</li>
              </ul>
              <div class="dr-inline" v-if="can.remarks">
                <input type="text" v-model="newRemark" placeholder="Write a remark and press Add" @keyup.enter="addRemark" />
                <button class="dr-quick" @click="addRemark" :disabled="busy || !newRemark.trim()">Add</button>
              </div>
            </div>

            <div class="dr-box" v-if="showLog">
              <table class="sb-log"><tbody>
                <tr v-for="e in events" :key="e.id"><td class="dr-hint nowrap">{{ formatDateTime(e.at) }}</td><td class="nowrap">{{ e.actor_name }}</td>
                  <td class="nowrap"><b>{{ EVENT_LABEL[e.type] || e.type }}</b></td><td>{{ eventText(e) }}</td></tr>
                <tr v-if="!events.length"><td colspan="4" class="empty">Nothing recorded yet.</td></tr>
              </tbody></table>
            </div>

            <div class="dr-box" v-if="showMore">
              <div class="dr-inline">
                <button v-if="backTargets.length" @click="openMore('back')" :disabled="busy">Move back…</button>
                <button v-if="status !== 'cancelled'" class="danger" @click="openMore('cancel')" :disabled="busy">Cancel runsheet…</button>
              </div>
              <div class="dr-inline" v-if="panel === 'back'" style="margin-top:8px">
                <label>Move back to</label>
                <select v-model="backTo" class="dr-select"><option v-for="st in backTargets" :key="st" :value="st">{{ STATUS_LABEL[st] }}</option></select>
                <input type="text" v-model="reason" placeholder="Why? (required)" @keyup.enter="confirmBack" />
                <button class="primary" @click="confirmBack" :disabled="busy">Move back</button>
              </div>
              <div class="dr-inline" v-if="panel === 'cancel'" style="margin-top:8px">
                <input type="text" v-model="reason" placeholder="Why cancel? (required)" @keyup.enter="confirmCancel" />
                <button class="primary danger" @click="confirmCancel" :disabled="busy">Cancel runsheet</button>
              </div>
            </div>
          </div>
          </td></tr>
        </template>
        <tr v-if="!visible.length"><td colspan="10" class="empty">No runsheets match.</td></tr>
      </tbody>
    </table>
    <div class="sb-more" v-if="filtered.length > shown">
      <button class="small" @click="shown += 25">Show more ({{ filtered.length - shown }} more)</button>
    </div>
    <p class="hint" v-if="!loading">A grey delivery date is the one the office planned, not yet confirmed by reception. RI / CTN = round items / cartons on the runsheet.</p>
  </div>
  `,
};

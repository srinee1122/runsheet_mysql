import { Api } from '../lib/api.js';
import ProductPicker from './product-picker.js';

export default {
  components: { ProductPicker },
  data() {
    return {
      products: [],
      columns: [], // [{ product_id, code }]
      // delivery companies and staff (used on the Status board's handover)
      companies: [], staff: [],
      newCompany: { name: '', kind: 'thirdparty' },
      newStaff: { name: '', company_id: '', roles: { driver: false, del_man: false, puller: false, crew: false } },
      ROLES: [{ key: 'driver', label: 'Driver' }, { key: 'del_man', label: 'Delivery man' }, { key: 'puller', label: 'Puller' }, { key: 'crew', label: 'Loading crew' }],
      saved: false,
    };
  },
  async mounted() {
    this.products = await Api.get('/api/products');
    const cols = await Api.get('/api/settings/frequent-columns');
    this.columns = cols.length ? cols : [];
    await this.loadPeople();
  },
  methods: {
    productById(id) { return this.products.find(p => p.id === id); },
    addColumn() {
      if (this.columns.length >= 15) return;
      this.columns.push({ product_id: null, code: '' });
    },
    removeColumn(i) { this.columns.splice(i, 1); },
    async saveColumns() {
      await Api.put('/api/settings/frequent-columns', { columns: this.columns });
      this.saved = true;
      setTimeout(() => (this.saved = false), 1500);
    },
    // Packing type lives on the product itself (so it stays in sync everywhere the product
    // is used, not just here) — this writes straight through to /api/products/:id.
    async setPackingType(productId, packing_type) {
      const p = this.productById(productId);
      if (!p) return;
      await Api.put(`/api/products/${productId}`, { ...p, packing_type });
      p.packing_type = packing_type;
    },
    // Same idea for entry unit — how this product's round-item quantity is normally counted.
    async setEntryUnit(productId, entry_unit) {
      const p = this.productById(productId);
      if (!p) return;
      await Api.put(`/api/products/${productId}`, { ...p, entry_unit });
      p.entry_unit = entry_unit;
    },
    // ---- delivery companies & staff ----
    async loadPeople() {
      [this.companies, this.staff] = await Promise.all([Api.get('/api/companies'), Api.get('/api/staff')]);
    },
    async run(fn) { try { await fn(); } catch (e) { alert(e.message); } await this.loadPeople(); },
    addCompany() {
      const c = this.newCompany; if (!c.name.trim()) return;
      this.run(async () => { await Api.post('/api/companies', c); this.newCompany = { name: '', kind: 'thirdparty' }; });
    },
    saveCompany(c) { this.run(() => Api.put(`/api/companies/${c.id}`, c)); },
    removeCompany(c) {
      const n = this.staff.filter(s => s.company_id === c.id).length;
      if (!confirm(`Delete ${c.name}?` + (n ? `\n\n${n} staff member(s) will be left without a company.` : '') + `\n\nRunsheets already handed over keep the company name they were recorded with. To stop offering it but keep it, untick Active instead.`)) return;
      this.run(() => Api.delete(`/api/companies/${c.id}`));
    },
    addStaff() {
      const s = this.newStaff; if (!s.name.trim()) return;
      this.run(async () => { await Api.post('/api/staff', { ...s, company_id: s.company_id || null });
        this.newStaff = { name: '', company_id: '', roles: { driver: false, del_man: false, puller: false, crew: false } }; });
    },
    saveStaff(p) { this.run(() => Api.put(`/api/staff/${p.id}`, { ...p, company_id: p.company_id || null })); },
    removeStaff(p) { if (confirm(`Remove ${p.name} from the staff list?`)) this.run(() => Api.delete(`/api/staff/${p.id}`)); },
  },
  template: `
  <div class="page-head">
    <div><h1>Settings</h1><div class="sub">Frequent round-item columns, delivery companies and staff.</div></div>
  </div>

  <div class="panel">
    <h2 style="margin-top:0;font-size:15px;">Frequent round-item columns
      <span class="hint">(up to 15 &mdash; any product can be a round item on a stop; these are just the ones that get their own column at the top of the printed sheet instead of falling into the All Round Items matrix)</span></h2>
    <p class="hint" v-if="!products.length">No products yet. Add or import some on the Products page first.</p>
    <div v-for="(col, i) in columns" :key="i" class="field-row" style="align-items:flex-end;margin-bottom:10px;">
      <div class="field" style="flex:2;">
        <label>Product</label>
        <ProductPicker :products="products" v-model="col.product_id" placeholder="Search any product…" />
        <div class="hint" v-if="productById(col.product_id)">qty/ctn: {{ productById(col.product_id).qty_per_ctn }}</div>
      </div>
      <div class="field" style="flex:1;">
        <label>Column code (short name shown on the sheet)</label>
        <input type="text" v-model="col.code" placeholder="e.g. OG 5K" />
      </div>
      <div class="field" style="flex:none;width:130px;" v-if="productById(col.product_id)">
        <label>Packing <span class="hint">(billing only)</span></label>
        <select :value="productById(col.product_id).packing_type || 'carton'" @change="setPackingType(col.product_id, $event.target.value)">
          <option value="carton">Carton</option>
          <option value="bag">Bag</option>
        </select>
      </div>
      <div class="field" style="flex:none;width:120px;" v-if="productById(col.product_id)">
        <label>Entry unit</label>
        <select :value="productById(col.product_id).entry_unit || 'CTN'" @change="setEntryUnit(col.product_id, $event.target.value)">
          <option value="CTN">Cartons</option>
          <option value="PCS">Pieces</option>
        </select>
      </div>
      <div class="field" style="flex:none;">
        <button class="danger" @click="removeColumn(i)">Remove</button>
      </div>
    </div>
    <button @click="addColumn" :disabled="columns.length >= 15">+ Add column ({{ columns.length }}/15)</button>
    <div class="modal-actions" style="justify-content:flex-start;margin-top:14px;">
      <button class="primary" @click="saveColumns">Save columns</button>
      <span class="hint" v-if="saved" style="color:var(--good)">Saved.</span>
    </div>
    <p class="hint" style="margin-top:10px;">Packing (Carton vs Bag) is only used to tell delivery cost apart, since 3rd-party
      vendors charge differently for each — it never changes any carton/package counts on the sheet. Entry unit (Cartons vs
      Pieces) just controls what unit the round-item quantity field defaults to and displays as for this product &mdash; it's
      always stored as cartons either way. Both are properties of the product itself, so setting them here updates them
      everywhere, including any other sheet that uses the same product. You can also set them on the Products page.</p>
  </div>

  <div class="panel">
    <h2 style="margin-top:0;font-size:15px;">Delivery companies
      <span class="hint">(who takes a runsheet out, and so who we pay — picked at handover through the driver)</span></h2>
    <table class="set-table">
      <thead><tr><th>Company</th><th>Type</th><th class="center">Active</th><th></th></tr></thead>
      <tbody>
        <tr v-for="c in companies" :key="c.id" :class="{ inactive: !c.active }">
          <td><input type="text" v-model="c.name" @change="saveCompany(c)" /></td>
          <td><select v-model="c.kind" @change="saveCompany(c)"><option value="inhouse">In-house</option><option value="thirdparty">Third-party</option></select></td>
          <td class="center"><input type="checkbox" v-model="c.active" @change="saveCompany(c)" title="Untick to stop offering it, while keeping it for history" /></td>
          <td class="right"><button class="ghost small danger" @click="removeCompany(c)">Delete</button></td>
        </tr>
        <tr class="set-add">
          <td><input type="text" v-model="newCompany.name" placeholder="New company name" @keyup.enter="addCompany" /></td>
          <td><select v-model="newCompany.kind"><option value="inhouse">In-house</option><option value="thirdparty">Third-party</option></select></td>
          <td></td><td class="right"><button class="primary small" @click="addCompany">Add</button></td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="panel">
    <h2 style="margin-top:0;font-size:15px;">Staff
      <span class="hint">(offered on the Status board's handover — each dropdown lists only the people with that role; any other name can still be typed in)</span></h2>
    <table class="set-table">
      <thead><tr><th>Name</th><th>Company</th><th v-for="r in ROLES" :key="r.key" class="center">{{ r.label }}</th><th class="center">Active</th><th></th></tr></thead>
      <tbody>
        <tr v-for="p in staff" :key="p.id" :class="{ inactive: !p.active }">
          <td><input type="text" v-model="p.name" @change="saveStaff(p)" /></td>
          <td><select v-model="p.company_id" @change="saveStaff(p)"><option :value="null">—</option>
            <option v-for="c in companies" :key="c.id" :value="c.id">{{ c.name }}{{ c.active ? '' : ' (archived)' }}</option></select></td>
          <td v-for="r in ROLES" :key="r.key" class="center"><input type="checkbox" v-model="p.roles[r.key]" @change="saveStaff(p)" /></td>
          <td class="center"><input type="checkbox" v-model="p.active" @change="saveStaff(p)" /></td>
          <td class="right"><button class="ghost small danger" @click="removeStaff(p)">Remove</button></td>
        </tr>
        <tr class="set-add">
          <td><input type="text" v-model="newStaff.name" placeholder="New name" @keyup.enter="addStaff" /></td>
          <td><select v-model="newStaff.company_id"><option value="">—</option>
            <option v-for="c in companies.filter(c => c.active)" :key="c.id" :value="c.id">{{ c.name }}</option></select></td>
          <td v-for="r in ROLES" :key="r.key" class="center"><input type="checkbox" v-model="newStaff.roles[r.key]" /></td>
          <td></td><td class="right"><button class="primary small" @click="addStaff">Add</button></td>
        </tr>
      </tbody>
    </table>
    <p class="hint" v-if="staff.some(p => !Object.values(p.roles).some(Boolean))">Someone with no role ticked isn't offered in any dropdown.</p>
  </div>
  `,
};

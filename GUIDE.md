# Step 1 + Part A — statuses, permissions, Status board tracking, delivery companies
Test locally first, then deploy. Keep this open while you work.

"Project root" = the folder that contains `server.js` and `package.json`. Locally:
`C:\Users\srini\Claude Apps\Runsheet-MySql\runsheet-mysql-project\runsheet-mysql`

This package is the complete, current set. It replaces the earlier Step 1 + Part A zip and
every file from the rounds before it (loose pieces, the Pieces save fix, the UEN). Apply all
of it, whatever you'd already applied.

## The 19 files and where they go

| Folder (inside the project root) | Files |
|---|---|
| project root | `server.js`, `db.js`, `schema.js`, `auth.js` |
| `public\` | `app.js`, `style.css`, `print.html`, `print.js`, `print.css` |
| `public\lib\` | `modules.js`, `runsheet-data.js`, `excel-export.js` |
| `public\components\` | `builder.js`, `matrix-view.js`, `history.js`, `status-board.js`, `users.js`, `settings.js`, `products.js` |

The folders mirror your project: copy the four root files and the `public` folder onto the
project root and let Windows replace the files. Don't copy this guide in. No new packages.

---

## Part A — test locally

### A1. Back up the code
Copy the whole project folder somewhere safe.

### A2. Back up the local database
HeidiSQL → right-click **runsheet** → **Export database as SQL**. Tick *Drop* and *Create*
for tables and *Insert* for data, one `.sql` file, Export.

(If you already ran the earlier Step 1 + Part A zip locally, there's nothing to undo: this
version just adds its new parts on the next start, keeping everything the earlier one did.)

### A3. Copy in the 19 files

### A4. `start-server.bat` must have this line (skip if already there)
    set BOOTSTRAP_ADMIN_EMAIL=srini@sriambikas.com
Above `npm start`, no spaces around `=`, no trailing space. This makes you super user.

### A5. Start the server
You should see:

    [db] Backfilled status/invoice index for NN runsheet(s) (one-time)
    [db] Gave Prepare + Remarks to N existing Builder user(s) (one-time)
    [db] Moved N name(s) from the old staff list into Staff (one-time)
    [db] Connected to MySQL ...
    Sri Ambikas Runsheet Tool running at http://localhost:4500

If you'd already run the earlier zip, you'll only see the "Moved N name(s)" line, since the
other two already ran then. Stop and start it again: no "(one-time)" line may appear again.

### A6. Sign in, press Ctrl+F5 once

### A7. Check these

**Set-up (you, as super user)**
1. **Users & Permissions**: grid with *Pages* and *Actions*. Existing Builder users already
   have *Prepare* and *Remarks*.
2. Set one person up as **reception** — e.g. Ranjitha: *Status board*, *Hand over*,
   *Record delivery*, *Remarks*, nothing else.
3. **Settings → Delivery companies**: add your in-house team and a third-party one.
4. **Settings → Staff**: add a few people with their company and roles (Driver, Delivery man,
   Puller, Loading crew — several allowed). Names from the old list are already there with
   every role ticked; untick what doesn't apply.

**Office flow (Builder)**
5. **History** has a Status column; the filter opens on *Active*.
6. Open a Draft. **Mark Prepared** without a sheet number is refused. Type a number, click
   **Mark Prepared**, then **Mark Pending Delivery**. The Builder offers nothing beyond that.
7. **Save** with a sheet number or invoice already on another runsheet → refused, naming it.

**Reception flow (Status board)**
8. The board never shows Drafts, and has no run date. Columns: Sheet No, Status, To reception,
   Delivery date, Driver, RI / CTN, Back, Invoices, Not delivered, Returns. A grey delivery
   date is still the Builder's plan. **Refresh** reloads it (it also refreshes by itself).
9. Open the Pending runsheet. **Going out**: *Handed to reception* (**Today**), *Delivery
   date* (starts from the Builder's, change it to the actual), *Entered by* (shows your name
   as a hint — leave it and your login is recorded, or type a colleague's name). Pick a
   **driver**: their company fills in. Delivery man, vehicle, time in, puller, crew as before.
10. **Hand over → Out for Delivery**. A **Coming back** section now appears.
11. **Print** it: DEL DATE shows the actual delivery date; DEL MAN, DRIVER · COMPANY, VEH NO,
    TIME OUT / IN are filled. None of the tracking-only details print.
12. **Coming back**: *Runsheet received back* (**Today**), *Received all invoices?* — **No**
    shows the runsheet's invoices to tick the missing ones — round items / cartons not
    delivered, *Has return goods?*, *Entered by*. The outcome is suggested (Partial if
    anything came back short). **Record Partial / Full Delivery** sets the status; it can be
    corrected later the same way. The table row fills in.
13. Add a **remark**.

**Super user**
14. **Move back…** and **Cancel runsheet…** each insist on a reason; the **Activity log**
    tells the whole story. Moving a runsheet back to Draft takes it off the board.
15. In a private window as the reception person: only the Status board; History, Builder and
    Users bounce back to it.
16. Rename a company in Settings: runsheets already handed over keep the old name.
17. Loose pieces, Version History, the frozen table and everything else work as before.

If anything looks wrong, stop and send a screenshot plus the Command Prompt output.

### A8. Putting local back (only if needed)
Stop the server, copy the code backup (A1) back, restore the export (A2) in HeidiSQL
(File → Load SQL file on the runsheet database).

---

## Part B — deploy to GoDaddy

1. **Quiet time** — the first start changes the database (adds only, see below).
2. **Back up the live database** if Hosted Database offers an export.
3. In the project root: `git add -A`, `git commit -m "Step 1 + Part A"`, `git push`.
   (Check `git status` first if you'd rather `start-server.bat` stayed off GitHub.)
4. **Pull from GitHub** on GoDaddy. No Secrets changes needed.
5. **Runtime Logs**: the same lines as A5.
6. **Sign in, Ctrl+F5**, then straight away: give each person their ticks in **Users &
   Permissions**, and add companies and staff in **Settings**. Until someone is given *Hand
   over*, only you and anyone ticked Admin can hand a runsheet over.
7. **If something goes wrong**: put the A1 code backup back, commit, push, pull. The old
   version runs fine on the updated database — it ignores the additions.

---

## What the first start does to the database
- **Adds**: a status on every runsheet (sheet number → Prepared, none → Draft); a super-user
  flag and action permissions on every user (existing Builder users get Prepare + Remarks);
  an empty handover-details field on every runsheet; four new tables (activity log, invoice
  index, delivery companies, staff). Names in the old staff list are copied into Staff.
- **Changes nothing already saved**: runsheet contents, version history, products, customers,
  settings and existing page permissions stay exactly as they are.
- Runs **once**. After that, everything changes only through the app.

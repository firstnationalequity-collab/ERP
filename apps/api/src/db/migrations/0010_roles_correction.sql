-- 0010_roles_correction (owner, 18-11-2026): docs/roles.md had drifted from the owner's decisions.
-- Commit 04ef009 gave master.item.manage to the Planner and master.formula.manage to the QA Officer; the owner's
-- decisions are master.item.manage → Warehouse Manager + Purchase Manager and master.formula.manage → Production
-- Manager (QA must not draft what it approves). The seed only ADDS keys, so the two wrong grants are removed here.
--
-- Exactly these two (role, key) pairs, approved by the owner in chat 18-11-2026; nothing else is touched.
-- Acts as the SYSTEM user; the audit trigger stays on and records each removal with reason "roles.md correction".
-- On a fresh database (roles not seeded yet) this deletes nothing; the seed then creates the corrected bundles.

SELECT set_config('app.user_id', '1', true),
       set_config('app.company_id', '1', true),
       set_config('app.reason', 'roles.md correction', true);

DELETE FROM core.role_permissions rp
 USING core.roles r, core.permissions p
 WHERE r.id = rp.role_id
   AND p.id = rp.permission_id
   AND ((r.code = 'PLANNER'    AND p.key = 'master.item.manage')
     OR (r.code = 'QA_OFFICER' AND p.key = 'master.formula.manage'));

SELECT set_config('app.reason', '', true),
       set_config('app.user_id', '', true),
       set_config('app.company_id', '', true);

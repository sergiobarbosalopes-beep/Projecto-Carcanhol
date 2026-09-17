import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(
  new URL("../app/(protected)/administracao/admin-panel.tsx", import.meta.url),
  "utf8"
);
const skillDetail = panel.slice(
  panel.indexOf("function SkillDetail"),
  panel.indexOf("function StatusBadge")
);

test("Skill detail header keeps Editar usable beside long content", () => {
  assert.match(
    skillDetail,
    /className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"/
  );
  assert.match(
    skillDetail,
    /className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600"/
  );
  assert.match(
    skillDetail,
    /className=\{`\$\{SECONDARY_BUTTON_CLASS\} shrink-0 self-start whitespace-nowrap`\}/
  );
  assert.match(skillDetail, /type="button"[\s\S]*?>\s*Editar\s*<\/button>/);
});

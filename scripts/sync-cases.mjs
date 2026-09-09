// cpx-plugin 의 케이스 카드를 이 저장소로 복사한다.
// 케이스를 고치면 배포 전에 `npm run sync-cases` 로 다시 실행할 것.
import { readdirSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "cpx-plugin", "cpx", "skills", "start", "refs", "cases");
const DEST = join(HERE, "..", "src", "cases");

mkdirSync(DEST, { recursive: true });
const files = readdirSync(SRC).filter((f) => f.endsWith(".json"));
for (const f of files) {
  copyFileSync(join(SRC, f), join(DEST, f));
}

// esbuild(wrangler)는 정적 import만 번들에 넣으므로, 케이스 파일 목록을 동적으로
// 훑어 정적 import 문을 가진 manifest.js를 생성해 둔다.
const caseFiles = files
  .filter((f) => f !== "index.json" && f !== "personas.json")
  .sort();

const imports = caseFiles
  .map((f, i) => `import c${i} from "./${f}";`)
  .join("\n");
const entries = caseFiles
  .map((f, i) => `  ${JSON.stringify(f.replace(/\.json$/, ""))}: c${i},`)
  .join("\n");

const manifest = `// 자동 생성 파일. 손으로 고치지 말고 \`npm run sync-cases\` 를 다시 실행할 것.
${imports}

export const CASES = {
${entries}
};
`;

writeFileSync(join(DEST, "manifest.js"), manifest);
console.log(`동기화됨: ${files.length}개 파일 + manifest.js (${SRC} -> ${DEST})`);

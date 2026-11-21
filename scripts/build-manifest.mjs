// src/cases 의 카드 목록으로 manifest.js 를 만든다. 카드 원본은 이 저장소의 src/cases 다
// (예전에는 cpx-plugin 에서 복사해 왔다). 카드 파일을 추가·삭제했으면 `npm run manifest` 로 다시 만들 것.
import { readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEST = join(HERE, "..", "src", "cases");
const files = readdirSync(DEST).filter((f) => f.endsWith(".json"));

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

const manifest = `// 자동 생성 파일. 손으로 고치지 말고 \`npm run manifest\` 를 다시 실행할 것.
${imports}

export const CASES = {
${entries}
};
`;

writeFileSync(join(DEST, "manifest.js"), manifest);
console.log(`manifest.js 생성: 카드 ${caseFiles.length}개 (${DEST})`);

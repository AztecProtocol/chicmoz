export const buildCompileScript = (
  _githubUrl: string,
  _gitRef?: string,
  _subPath?: string,
): string => {
  // Arguments are passed via env vars (GIT_URL, GIT_REF, SUB_PATH) to avoid
  // shell injection — this script only references those env vars, never
  // interpolated user input.
  const checkoutRef = _gitRef
    ? `git checkout "$GIT_REF"`
    : "echo 'Using default branch'";
  const cdSubPath = _subPath
    ? `cd "/workspace/repo/$SUB_PATH"`
    : "cd /workspace/repo";
  const sourceRoot = _subPath ? `/workspace/repo/$SUB_PATH` : "/workspace/repo";

  return [
    `set -e`,
    `export RUST_BACKTRACE="\${RUST_BACKTRACE:-1}"`,
    `echo "===INPUTS_START==="`,
    `echo "GIT_URL=${_githubUrl}"`,
    `echo "GIT_REF=${_gitRef ?? ""}"`,
    `echo "SUB_PATH=${_subPath ?? ""}"`,
    `echo "AZTEC_VERSION=$AZTEC_VERSION"`,
    `echo "NARGO_HOME=$NARGO_HOME"`,
    `echo "RUST_BACKTRACE=$RUST_BACKTRACE"`,
    `echo "===INPUTS_END==="`,
    `echo "===STAGE:CLONE==="`,
    `echo "Cloning repository..."`,
    `git clone "$GIT_URL" /workspace/repo`,
    `cd /workspace/repo`,
    `echo "===STAGE:CHECKOUT==="`,
    `echo "Checking out git ref: ${_gitRef ?? "(default branch)"}"`,
    checkoutRef,
    `echo "Resolved HEAD: $(git rev-parse HEAD)"`,
    `git rev-parse HEAD > /output/commit_hash`,
    cdSubPath,
    `echo "===STAGE:COMPILE==="`,
    `echo "Compile working directory: $PWD"`,
    `echo "Detected package name before compile: $(awk -F'"' '/^name[[:space:]]*=[[:space:]]*"/ { print $2; exit }' Nargo.toml 2>/dev/null || true)"`,
    `echo "Compiling contract..."`,
    `ARTIFACT_MARKER_FILE="$(mktemp)"`,
    `touch "$ARTIFACT_MARKER_FILE"`,
    `echo "Running compile command: node --no-warnings /usr/src/yarn-project/aztec/dest/bin/index.js compile"`,
    `node --no-warnings /usr/src/yarn-project/aztec/dest/bin/index.js compile`,
    `echo "===STAGE:ARTIFACT_DISCOVERY==="`,
    `echo "Discovering compiled artifact..."`,
    `mkdir -p /output/artifact`,
    `CONTRACT_DIR_NAME="$(basename "$PWD")"`,
    `echo "Contract directory name: $CONTRACT_DIR_NAME"`,
    `ARTIFACT_PATHS="$(find /workspace/repo -type f -path "*/target/*.json" -newer "$ARTIFACT_MARKER_FILE" | sort)"`,
    `printf "%s\\n" "$ARTIFACT_PATHS" | sed '/^$/d' > /tmp/artifact-paths.txt`,
    `if [ ! -s /tmp/artifact-paths.txt ]; then echo "No compiled artifact found after compile (searched: /workspace/repo/**/target/*.json newer than marker)"; exit 1; fi`,
    `echo "Discovered artifact paths:"`,
    `cat /tmp/artifact-paths.txt`,
    `SELECTED_ARTIFACT_PATH="$(grep "/target/$CONTRACT_DIR_NAME" /tmp/artifact-paths.txt | head -n 1 || true)"`,
    `if [ -z "$SELECTED_ARTIFACT_PATH" ]; then SELECTED_ARTIFACT_PATH="$(head -n 1 /tmp/artifact-paths.txt)"; fi`,
    `echo "Selected artifact path after first pass: $SELECTED_ARTIFACT_PATH"`,
    `echo "Selected artifact transpiled flag after first pass: $(jq -r '.transpiled // "missing"' "$SELECTED_ARTIFACT_PATH" 2>/dev/null || echo "unreadable")"`,
    `if ! jq -e '.transpiled == true' "$SELECTED_ARTIFACT_PATH" >/dev/null 2>&1; then echo "Selected artifact is not transpiled: $SELECTED_ARTIFACT_PATH"; PACKAGE_NAME="$(awk -F'"' '/^name[[:space:]]*=[[:space:]]*"/ { print $2; exit }' Nargo.toml 2>/dev/null || true)"; WORKSPACE_ROOT=""; SEARCH_DIR="$PWD"; while [ "$SEARCH_DIR" != "/" ]; do if [ -f "$SEARCH_DIR/Nargo.toml" ] && grep -q '^\\[workspace\\]' "$SEARCH_DIR/Nargo.toml"; then WORKSPACE_ROOT="$SEARCH_DIR"; break; fi; if [ "$SEARCH_DIR" = "/workspace/repo" ]; then break; fi; SEARCH_DIR="$(dirname "$SEARCH_DIR")"; done; echo "Workspace root candidate: \${WORKSPACE_ROOT:-"(none)"}"; echo "Package name candidate: \${PACKAGE_NAME:-"(none)"}"; if [ -n "$PACKAGE_NAME" ] && [ -n "$WORKSPACE_ROOT" ]; then echo "Running fallback compile command: node --no-warnings /usr/src/yarn-project/aztec/dest/bin/index.js compile --package $PACKAGE_NAME"; echo "Recompiling from workspace root ($WORKSPACE_ROOT) with --package $PACKAGE_NAME to force postprocessing..."; cd "$WORKSPACE_ROOT"; node --no-warnings /usr/src/yarn-project/aztec/dest/bin/index.js compile --package "$PACKAGE_NAME"; ARTIFACT_PATHS="$(find /workspace/repo -type f -path "*/target/*.json" -newer "$ARTIFACT_MARKER_FILE" | sort)"; printf "%s\\n" "$ARTIFACT_PATHS" | sed '/^$/d' > /tmp/artifact-paths.txt; if [ ! -s /tmp/artifact-paths.txt ]; then echo "No compiled artifact found after workspace compile"; exit 1; fi; echo "Discovered artifact paths after fallback compile:"; cat /tmp/artifact-paths.txt; SELECTED_ARTIFACT_PATH="$(grep "/target/$CONTRACT_DIR_NAME" /tmp/artifact-paths.txt | head -n 1 || true)"; if [ -z "$SELECTED_ARTIFACT_PATH" ]; then SELECTED_ARTIFACT_PATH="$(head -n 1 /tmp/artifact-paths.txt)"; fi; echo "Selected artifact path after fallback compile: $SELECTED_ARTIFACT_PATH"; echo "Selected artifact transpiled flag after fallback compile: $(jq -r '.transpiled // "missing"' "$SELECTED_ARTIFACT_PATH" 2>/dev/null || echo "unreadable")"; else echo "Skipping fallback compile because package name or workspace root could not be determined"; fi; fi`,
    `if ! jq -e '.transpiled == true' "$SELECTED_ARTIFACT_PATH" >/dev/null 2>&1; then echo "Compiled artifact is still not transpiled: $SELECTED_ARTIFACT_PATH"; exit 1; fi`,
    `cp "$SELECTED_ARTIFACT_PATH" /output/artifact/`,
    `rm -f "$ARTIFACT_MARKER_FILE"`,
    `echo "===STAGE:SOURCE_EXTRACTION==="`,
    `echo "Copying source files from ${_subPath ?? "(repo root)"} (excluding .git)..."`,
    `mkdir -p /output/source`,
    `SOURCE_ROOT="${sourceRoot}"`,
    `cd "$SOURCE_ROOT"`,
    `find . -not -path './.git/*' -not -name '.git' | cpio -pdm /output/source/ 2>/dev/null || cp -r . /output/source/ && rm -rf /output/source/.git`,
    `mkdir -p /output/source/__repo_root__`,
    `find /workspace/repo -maxdepth 1 -type f '(' -iname 'LICENSE' -o -iname 'LICENSE.*' -o -iname 'LICENCE' -o -iname 'LICENCE.*' ')' -exec cp {} /output/source/__repo_root__/ ';'`,
    `echo "Done."`,
  ].join(" && ");
};

export const buildReaderScript = (): string => {
  return `set -e
echo "===COMMIT_HASH_START==="
cat /output/commit_hash 2>/dev/null || echo ""
echo "===COMMIT_HASH_END==="
ARTIFACT_FILE=$(find /output/artifact -name "*.json" -type f | sort | head -n 1)
if [ -z "$ARTIFACT_FILE" ]; then echo "NO_ARTIFACT_FOUND"; exit 1; fi
echo "===ARTIFACT_START==="
cat "$ARTIFACT_FILE"
echo ""
echo "===ARTIFACT_END==="
echo "===SOURCES_START==="
cd /output/source
find . -type f \\( -name "*.nr" -o -name "Nargo.toml" -o -path './__repo_root__/LICENSE*' -o -path './__repo_root__/LICENCE*' \\) | sort | while read f; do
  clean_path=$(echo "$f" | sed 's|^\\./||')
  content=$(cat "$f" | sed 's/\\\\/\\\\\\\\/g' | sed 's/"/\\\\"/g' | sed ':a;N;$!ba;s/\\n/\\\\n/g')
  echo "{\\"path\\":\\"$clean_path\\",\\"content\\":\\"$content\\"}"
done
echo "===SOURCES_END==="
`;
};

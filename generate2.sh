#!/usr/bin/env bash
#
# generate2.sh
#
# src/ の内容をもとに各 live 環境用のディレクトリ (dist/live01, dist/live02,
# dist/live03) を生成する。src をコピーしたうえで manifest.json を書き換え、
# 各拡張機能ごとに固有の name と key を設定する。
#
# 依存: jq
#
set -euo pipefail

cd "$(dirname "$0")"

SRC_DIR="src"
DIST_DIR="dist"

# 各 live 環境の固有 key (拡張機能 ID を決定する公開鍵)。
# ここを変更すると拡張機能 ID が変わるので注意。
KEY_01="MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwAgSuNo/kBSmBTTanMiOsP0et+Arh8C8Opr24UxPEV08o6doXvyJRCEoEsK3CDdzqrqHOU8VFnSbsYPQ8MVaoY8WIr3chva65BLZARAF8VLaNvIO6yJUAEFZcmNA5COyk63JNT2kXF3tCRzOpSN/6dwg1cIJskpBqV0UH+E+plKowUacbFNgLSX3VWEDR9aK86Bu87XagYGll9oc4I1S2OBuk+CLBn3W15dBO8MUE5WkwKGH8KCM2Y13vudaLQ21CWMeLLVEDR+s00vxghCZci68JUoZ45EBTsoIawIAHGq9WREhitFKjnRUArXDCQfkHjAWMl9A7KwFsAjliqnEUwIDAQAB"
KEY_02="MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwF64uDu6yywHSdBKnkfmV9jS6av4AGG05J3iDvlh1HOmCeh/eI7ybMoaIxSzG0Z05ckRMigK5Xyc6En1bTnBtEmXTY0Ww9dNdqXVGq0vRNaVleJAv8p59kDT4OqVMHW2524hnRli6L5FmH59OdpwDutQaFCXZdMu86UY1u9kN5CpX0H5qIiMPBBSSTIxWp5dqXeOgLeL2M8mZHWdVjjQlF+md2iuyzfrTenwukWbWo0zaHmJD3dhWDYeNSsYbw9SDBULpIJVo0scdKDkCcBrUB6t8hwNKZnVlOZ7Uy7X6hzx55bjNrhCFj4RNio/a6kZ5k7V0SQ4pm2/ISh7WGW8IwIDAQAB"
KEY_03="MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqF15+5FdbbhnVT/P0n12rL09QyVjUwOxeRzlhjQvXPnJLLS/tbfq/b/SXKVBfrPeVcuwOsqMLH25VYryeajUKhFQ8XT8cySXdb1HkZV8rExeNamDmAmRiJoFs6O8Vpr/oDLiyI8YGvWPAvCjBRJ/8SUSlWSroM81Z+6gaj5rIXOV6iVjL6+1JgoLEd99RWVrQCmugq7aBH+zTCIA0vtU1NhYBBUlrAJmGXVeNOleHm/GGYufCp4hKUSwRpiA7cEOj/WcMF3BkcXuDX9cLRQCxP3ZgQDOH3MBQglzxSPhdjqBRsm1fXTm2VosVECdZl0vR/OH5TqkD33o83hkzSM4ZwIDAQAB"

# 生成対象: "ディレクトリ名 番号 key"
build() {
  local name="$1" number="$2" key="$3"
  local out="${DIST_DIR}/${name}"

  echo "generating ${out} ..."

  rm -rf "${out}"
  mkdir -p "${out}"
  # src の中身 (manifest.json 含む) をすべてコピー
  cp -R "${SRC_DIR}/." "${out}/"

  # manifest.json を書き換え: name を live 用に変更し、key を追加する
  local manifest="${out}/manifest.json"
  local tmp
  tmp="$(mktemp)"
  jq \
    --arg name "Slack Notifier (${number}:DEV)" \
    --arg key "${key}" \
    '.name = $name | .key = $key' \
    "${manifest}" > "${tmp}"
  mv "${tmp}" "${manifest}"
}

build "live01" "01" "${KEY_01}"
build "live02" "02" "${KEY_02}"
build "live03" "03" "${KEY_03}"

echo "done."

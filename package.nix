{
  lib,
  buildNpmPackage,
  makeWrapper,
  nodejs,
  fetchurl,
}:

let
  data = builtins.fromJSON (builtins.readFile ./version.json);

  modelFile =
    name:
    fetchurl {
      url = "https://huggingface.co/DataikuNLP/kiji-pii-model-onnx/resolve/${data.revision}/${name}";
      hash = data.files.${name};
    };
in
buildNpmPackage {
  pname = "kiji-pii-server";
  version = "0.1.0";

  src = ./server;

  npmDepsHash = "sha256-Z8PYClNtM+vf2QcyrSPkj/sbp6QV1FWIbmRV8yUnjWM=";
  npmFlags = [ "--ignore-scripts" ];
  dontNpmBuild = true;
  npmRebuild = false;

  nativeBuildInputs = [ makeWrapper ];

  postInstall = ''
    mkdir -p $out/share/kiji
    install -Dm444 ${modelFile "model_quantized.onnx"} $out/share/kiji/model_quantized.onnx
    install -Dm444 ${modelFile "tokenizer.json"} $out/share/kiji/tokenizer.json
    install -Dm444 ${modelFile "tokenizer_config.json"} $out/share/kiji/tokenizer_config.json
    install -Dm444 ${modelFile "special_tokens_map.json"} $out/share/kiji/special_tokens_map.json
    install -Dm444 ${modelFile "label_mappings.json"} $out/share/kiji/label_mappings.json

    chmod +x $out/bin/kiji-pii-server
    wrapProgram $out/bin/kiji-pii-server \
      --prefix PATH : ${lib.makeBinPath [ nodejs ]} \
      --set KIJI_MODEL_DIR $out/share/kiji
  '';

  meta = with lib; {
    description = "HTTP PII redaction service using Kiji (ONNX int8)";
    homepage = "https://github.com/atomic-235/kiji-pii-flake";
    license = licenses.asl20;
    platforms = platforms.linux;
    mainProgram = "kiji-pii-server";
  };
}

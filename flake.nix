{
  description = "Kiji PII detection as a local redaction service";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          service = pkgs.callPackage ./package.nix { };
        in
        rec {
          default = service;
          kiji-pii = service;
        }
      );

      overlays.default = final: _prev: {
        kiji-pii = final.callPackage ./package.nix { };
      };
    };
}

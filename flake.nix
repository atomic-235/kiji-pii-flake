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

          # `docker load -i result` gives a local image; CI pushes it to ghcr.
          # KIJI_HOST must be 0.0.0.0 inside the container, and the port is published
          # on the host loopback so the service is never exposed off-machine.
          docker = pkgs.dockerTools.buildLayeredImage {
            name = "ghcr.io/atomic-235/kiji-pii";
            tag = "latest";
            contents = [ pkgs.cacert ];
            config = {
              Entrypoint = [ "${service}/bin/kiji-pii-server" ];
              ExposedPorts = {
                "8788/tcp" = { };
              };
              Env = [
                "KIJI_HOST=0.0.0.0"
                "KIJI_PORT=8788"
              ];
            };
          };
        }
      );

      overlays.default = final: _prev: {
        kiji-pii = final.callPackage ./package.nix { };
      };
    };
}

// Generate os-list.json for the Raspberry Pi Imager from the image-meta.json
// that build-image.sh produced. Users add this repository in the Imager
// (or run: rpi-imager --repo <url>) and "Helio Agent" shows up as an OS.
//
//   node scripts/pi-image/make-os-list.mjs <image-meta.json> <outfile> [version]
//
// The URLs are "latest" release links on purpose: one stable address that
// always points at the newest image, so the Imager repo URL never changes.
import fs from "node:fs";

const [metaFile, outFile, version = ""] = process.argv.slice(2);
if (!metaFile || !outFile) {
  console.error("usage: node make-os-list.mjs <image-meta.json> <outfile> [version]");
  process.exit(1);
}
const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));

const osList = {
  os_list: [
    {
      name: `Helio Agent${version ? ` ${version}` : ""}`,
      description:
        "Raspberry Pi OS Lite (64-bit) with the Helio solar agent preinstalled. " +
        "Boot it on the inverter's network, open http://helio-agent.local and " +
        "approve the pairing code — the agent finds the Solarman stick and " +
        "streams it to Helio. Updates itself.",
      icon: "https://helio-power.eu/logo.png",
      url: "https://github.com/dashwoodboy/helio-agent/releases/latest/download/HelioAgent-Pi.img.xz",
      extract_size: meta.extract_size,
      extract_sha256: meta.extract_sha256,
      image_download_size: meta.image_download_size,
      image_download_sha256: meta.image_download_sha256,
      release_date: meta.release_date,
      // Raspberry Pi OS Bookworm applies the Imager's hostname/Wi-Fi/user
      // customization through its firstboot machinery (not cloud-init).
      init_format: "systemd",
      devices: [
        "pi5-64bit",
        "pi4-64bit",
        "pi400-64bit",
        "pi3-64bit",
        "cm4-64bit",
        "pizero2-64bit",
      ],
    },
  ],
};

fs.writeFileSync(outFile, JSON.stringify(osList, null, 2) + "\n");
console.log(`wrote ${outFile}`);

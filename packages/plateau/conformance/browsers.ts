// The browsers the test runners launch, and how Firefox starts where it cannot create its own data
// folder.
//
// Firefox's profile service first creates its data folder (`~/Library/Application Support/Firefox`
// on macOS), even when it is given a profile. Where that fails, Firefox exits with "Could not find
// profile folder." before Playwright can connect. A sandbox that guards a real Firefox's cookies and
// passwords by denying that one folder does this (seen on macOS 27.2 with Playwright's Firefox 159).
// Then Firefox is started with `-app` and an application.ini whose `Profile=` names another data
// folder, `PlateauFirefox`; the ini sits in a temporary folder of links to Firefox's own `browser/`
// files, which `-app` reads from the ini's folder.

import { mkdir, readdir, readFile, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium, firefox, webkit, type BrowserType, type LaunchOptions } from "playwright";

export const types: Record<string, BrowserType> = { chromium, webkit, firefox };

let firefoxLaunch: Promise<LaunchOptions> | null = null;

/** Options every launch of browser `b` takes. */
export function launchOptions(b: string): Promise<LaunchOptions> {
  if (b !== "firefox") return Promise.resolve({});
  firefoxLaunch ??= firefoxOptions();
  return firefoxLaunch;
}

async function firefoxOptions(): Promise<LaunchOptions> {
  try {
    await (await firefox.launch({ headless: true })).close();
    return {};
  } catch (e) {
    if (process.platform !== "darwin" || !String(e).includes("Could not find profile folder")) throw e;
  }
  const exe = firefox.executablePath();
  const resources = join(dirname(exe), "..", "Resources");
  const dir = join(tmpdir(), "plateau-firefox-app");
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(join(resources, "browser"))) {
    await symlink(join(resources, "browser", name), join(dir, name)).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    });
  }
  const ini = (await readFile(join(resources, "application.ini"), "utf8")).replace(/^\[App\]$/m, "[App]\nProfile=PlateauFirefox");
  await writeFile(join(dir, "application.ini"), ini);
  const wrapper = join(dir, "firefox.sh");
  await writeFile(wrapper, `#!/bin/sh\nexec "${exe}" -app "${join(dir, "application.ini")}" "$@"\n`);
  await chmod(wrapper, 0o755);
  console.log(`[firefox] its data folder cannot be created here; starting it with -app ${join(dir, "application.ini")} (data folder PlateauFirefox)`);
  return { executablePath: wrapper };
}

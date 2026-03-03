import fs from "node:fs";
import path from "node:path";

export function resolveWorkspaceForMcp(workspace, defaultWorkspace) {
  const normalRoot   = path.resolve(fs.realpathSync(defaultWorkspace));
  const normalTarget = path.resolve(fs.realpathSync(workspace || defaultWorkspace));
  const root   = normalRoot;
  const target = normalTarget;

  if (process.env.CODER_ALLOW_ANY_WORKSPACE === "1") return target;

  // Pre-resolution: the physical path of `workspace` must already be within root.
  // Catches symlinks outside root that point inside (e.g. /tmp/link → /root/dir).
  if (normalTarget !== normalRoot && !normalTarget.startsWith(normalRoot + path.sep)) {
    throw new Error(
      `Workspace must be within server root: ${root}. ` +
        "Set CODER_ALLOW_ANY_WORKSPACE=1 to allow arbitrary paths.",
    );
  }

  // Post-resolution: the resolved target must also be within root.
  // Catches symlinks inside root that point outside (e.g. /root/link → /etc).
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(
      `Workspace must be within server root: ${root}. ` +
        "Set CODER_ALLOW_ANY_WORKSPACE=1 to allow arbitrary paths.",
    );
  }
  return target;
}

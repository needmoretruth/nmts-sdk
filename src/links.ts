// Public links (NCF-3 §5.8): the four `nmts link` verbs, with the terminal taken off.
//
// ⛔ THE SAME CODE AS THE COMMAND-LINE TOOL. Making, listing, cutting and opening are the portable
//    functions `nmts link` runs; this file only finds the file by path and hands over the account.
//
// ⛔ OPENING NEEDS NO ACCOUNT, so it is a static on `Nmts` and takes only where to talk. The file
//    comes back in memory, checked against the digest the owner sealed — the same ceiling and the
//    same refusal as `get()`.

import {
  entryAt,
  KIND_FILE,
  listLinks,
  makeLink,
  NmtsError,
  openLink,
  resolveNetwork,
  resolveServer,
  revokeLink,
  type LinkAccount,
  type ListedLink,
  type MadeLink,
  type ManifestEntry,
  type ReadOptions,
} from "@needmoretruth/nmts-cli/portable";

import { bytesSink, DEFAULT_IN_MEMORY_LIMIT } from "./get.ts";
import { readList } from "./list.ts";
import { withAccount, type Held, type Opened, type ServerOptions } from "./session.ts";

export type { ListedLink, MadeLink } from "@needmoretruth/nmts-cli/portable";

export interface MakeLinkOptions {
  /** Seal the size without the file's name; the page then shows "Shared file". Default false. */
  hideName?: boolean;
  /** Days until the link stops working, 1 to 3650. Absent = until it is cut. */
  expiresDays?: number;
}

export interface OpenLinkOptions extends ServerOptions {
  /** The in-memory ceiling, as for `get()`. Default 256 MiB. */
  maxBytes?: number;
}

export interface OpenedLinkBytes {
  /** The file's name, or null when the owner hid it. */
  name: string | null;
  bytes: Uint8Array;
}

const accountOf = (held: Held): LinkAccount => ({ server: held.server, bearer: held.bearer, code: held.code });

async function fileAt(held: Held, path: string): Promise<ManifestEntry> {
  const { entries } = await readList(held);
  if (entries.length === 0) {
    throw new NmtsError("This account has no file list, so there is nothing to link.", { exitCode: 4 });
  }
  const entry = entryAt(entries, path, { nothingHappened: "Nothing was changed." });
  if (entry.kind !== KIND_FILE) {
    throw new NmtsError(`"${path}" is a folder.`, { exitCode: 4, nextStep: "Nothing was changed. A link is to one file." });
  }
  return entry;
}

export async function makeLinkAt(opened: Opened, path: string, options: MakeLinkOptions): Promise<MadeLink> {
  const days = options.expiresDays ?? null;
  if (days !== null && (!Number.isSafeInteger(days) || days < 1 || days > 3650)) {
    throw new NmtsError("expiresDays takes a whole number of days from 1 to 3650.", { exitCode: 2 });
  }
  return withAccount(opened, async (held) =>
    makeLink(accountOf(held), await fileAt(held, path), { showName: options.hideName !== true, expiresDays: days }),
  );
}

export async function listLinksAt(opened: Opened, path: string): Promise<ListedLink[]> {
  return withAccount(opened, async (held) => listLinks(accountOf(held), (await fileAt(held, path)).id));
}

export async function revokeLinkOf(opened: Opened, id: string): Promise<void> {
  return withAccount(opened, async (held) => revokeLink(accountOf(held), id));
}

export async function openLinkBytes(link: string, options: OpenLinkOptions, read: ReadOptions | undefined): Promise<OpenedLinkBytes> {
  const server = resolveServer(options.server);
  const memory = bytesSink(options.maxBytes ?? DEFAULT_IN_MEMORY_LIMIT);
  const opened = await openLink({
    link,
    server,
    chain: resolveNetwork(server, options.network),
    sink: () => memory.sink,
    ...(read === undefined ? {} : { read }),
  });
  return { name: opened.name, bytes: memory.take() };
}

// A Next.js client component that puts a file from a file picker into the person's own NMTS
// account, from the page, with the account code never leaving the browser.
//
// Copy this file into `app/` (or `components/`) of a Next.js app and render <UploadButton />.
// It imports the browser entry: the same class and the same verbs as the Node one, with the
// engine loaded as WebAssembly and the sealed file list kept in IndexedDB.
//
// The person types their account code and API key here because the page is where they hold it.
// What that means: the code is in this page's memory while the tab is open, and this page's code
// is yours. They are as safe as their trust in you — see "Who holds the key" in the README.
"use client";

import { useState } from "react";
import { Nmts } from "@needmoretruth/nmts-sdk/browser";

export default function UploadButton() {
  const [accountCode, setAccountCode] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState("");

  async function onPick(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    // One client per action: nothing keeps the code once the call returns.
    const nmts = Nmts.device({ accountCode, apiKey });
    setStatus(`sealing ${file.name}…`);
    try {
      const put = await nmts.put({ name: file.name, blob: file });
      const entries = await nmts.list();
      setStatus(`stored ${put.path} (${put.bytes} bytes, ${put.credits} credit(s)); the account has ${entries.length} entries`);
    } catch (error) {
      // Every refusal names what did not happen and what to do next; showing it is enough.
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <input type="password" placeholder="NMTS key" value={accountCode} onChange={(e) => setAccountCode(e.target.value)} />
      <input type="password" placeholder="API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      <input type="file" onChange={onPick} disabled={!accountCode || !apiKey} />
      <p role="status">{status}</p>
    </form>
  );
}

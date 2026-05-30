const CHANNEL_NAME = "anitrace-share";
const LOCK_NAME = "anitrace-share-handoff";
const HANDOFF_TIMEOUT_MS = 350;

interface ShareRequestMessage {
  type: "share-request";
  requestId: string;
  senderId: string;
  url: string;
}

interface ShareClaimedMessage {
  type: "share-claimed";
  requestId: string;
}

type ShareChannelMessage = ShareRequestMessage | ShareClaimedMessage;

function isShareRequest(msg: unknown): msg is ShareRequestMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as ShareRequestMessage).type === "share-request" &&
    typeof (msg as ShareRequestMessage).requestId === "string" &&
    typeof (msg as ShareRequestMessage).senderId === "string" &&
    typeof (msg as ShareRequestMessage).url === "string"
  );
}

/**
 * When Shortcuts opens a new Safari tab, ask an already-open AniTrace tab to
 * handle the URL instead of running a duplicate search in this tab.
 */
export async function tryDelegateShareToExistingTab(
  url: string,
  senderId: string
): Promise<boolean> {
  if (typeof BroadcastChannel === "undefined") return false;

  const requestId = crypto.randomUUID();
  const channel = new BroadcastChannel(CHANNEL_NAME);

  return new Promise((resolve) => {
    let settled = false;

    const finish = (delegated: boolean) => {
      if (settled) return;
      settled = true;
      channel.close();
      resolve(delegated);
    };

    channel.onmessage = (event: MessageEvent<ShareChannelMessage>) => {
      const data = event.data;
      if (data?.type === "share-claimed" && data.requestId === requestId) {
        finish(true);
      }
    };

    channel.postMessage({
      type: "share-request",
      requestId,
      senderId,
      url,
    } satisfies ShareRequestMessage);
    setTimeout(() => finish(false), HANDOFF_TIMEOUT_MS);
  });
}

/** Existing tabs listen for share handoffs from newly opened Shortcut tabs. */
export function listenForShareHandoff(
  tabId: string,
  onShare: (url: string) => void
): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};

  const channel = new BroadcastChannel(CHANNEL_NAME);

  channel.onmessage = (event: MessageEvent<ShareChannelMessage>) => {
    const data = event.data;
    if (!isShareRequest(data) || data.senderId === tabId) return;

    const handle = () => {
      channel.postMessage({
        type: "share-claimed",
        requestId: data.requestId,
      } satisfies ShareClaimedMessage);
      onShare(data.url);
      window.focus?.();
    };

    if (navigator.locks) {
      void navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        handle();
      });
      return;
    }

    handle();
  };

  return () => channel.close();
}

/** Best-effort close for the throwaway tab Shortcuts opens on iOS. */
export function tryCloseHandoffTab(): void {
  window.close();
}

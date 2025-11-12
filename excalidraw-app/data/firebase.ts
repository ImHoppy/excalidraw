import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { FILE_CACHE_MAX_AGE_SEC } from "../app_constants";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

// Custom Backend Configuration
// -----------------------------------------------------------------------------

const CUSTOM_BACKEND_BASE_URL = "http://localhost:3000/api";

// Utility functions for file handling (still need base64 for files)
// -----------------------------------------------------------------------------

const arrayBufferToBase64 = (buffer: ArrayBuffer | Uint8Array): string => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

// Types
// -----------------------------------------------------------------------------

type CustomStoredScene = {
  sceneVersion: number;
  elements: readonly ExcalidrawElement[]; // Plain JSON elements (no encryption)
};

// No encryption - elements are stored as plain JSON

class CustomSceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return CustomSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    CustomSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return CustomSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const loadFirebaseStorage = async () => {
  // For compatibility, return a mock object
  return {};
};

export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const response = await fetch(`${CUSTOM_BACKEND_BASE_URL}/files`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prefix: prefix.replace(/^\//, ""),
            fileId: id,
            buffer: arrayBufferToBase64(buffer),
            cacheControl: `public, max-age=${FILE_CACHE_MAX_AGE_SEC}`,
          }),
        });

        if (response.ok) {
          savedFiles.push(id);
        } else {
          erroredFiles.push(id);
        }
      } catch (error: any) {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

const createCustomSceneDocument = (
  elements: readonly SyncableExcalidrawElement[],
) => {
  const sceneVersion = getSceneVersion(elements);
  return {
    sceneVersion,
    elements,
  } as CustomStoredScene;
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, elements)
  ) {
    return null;
  }

  try {
    // First, get the current scene if it exists
    const getResponse = await fetch(
      `${CUSTOM_BACKEND_BASE_URL}/scenes/${roomId}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    let reconciledElements: readonly SyncableExcalidrawElement[] = elements;

    if (getResponse.ok) {
      // Scene exists, need to reconcile
      const prevStoredScene = (await getResponse.json()) as CustomStoredScene;
      const prevStoredElements = getSyncableElements(
        restoreElements(prevStoredScene.elements, null),
      );
      reconciledElements = getSyncableElements(
        reconcileElements(
          elements,
          prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
          appState,
        ),
      );
    }

    // Create the document to save
    const storedScene = createCustomSceneDocument(reconciledElements);

    // Save to backend
    const saveResponse = await fetch(
      `${CUSTOM_BACKEND_BASE_URL}/scenes/${roomId}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ data: storedScene }),
      },
    );

    if (!saveResponse.ok) {
      throw new Error(`Failed to save scene: ${saveResponse.statusText}`);
    }

    const storedElements = getSyncableElements(
      restoreElements(storedScene.elements, null),
    );

    CustomSceneVersionCache.set(socket, storedElements);

    return storedElements;
  } catch (error) {
    console.error("Error saving to custom backend:", error);
    return null;
  }
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  try {
    const response = await fetch(
      `${CUSTOM_BACKEND_BASE_URL}/scenes/${roomId}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    if (!response.ok) {
      return null;
    }

    const storedScene = (await response.json()) as CustomStoredScene;
    const elements = getSyncableElements(
      restoreElements(storedScene.elements, null, {
        deleteInvisibleElements: true,
      }),
    );

    if (socket) {
      CustomSceneVersionCache.set(socket, elements);
    }

    return elements;
  } catch (error) {
    console.error("Error loading from custom backend:", error);
    return null;
  }
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const response = await fetch(
          `${CUSTOM_BACKEND_BASE_URL}/files/${encodeURIComponent(
            prefix.replace(/^\//, ""),
          )}/${id}`,
        );

        if (response.status < 400) {
          const fileData = await response.json();
          const arrayBuffer = base64ToArrayBuffer(fileData.buffer);

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};

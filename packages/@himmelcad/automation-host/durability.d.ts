interface DirectoryHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

interface DirectoryFilesystem {
  open(path: string, flags: 'r'): Promise<DirectoryHandle>;
}

export function syncDirectory(
  filesystem: DirectoryFilesystem,
  directory: string,
  platform?: NodeJS.Platform,
): Promise<boolean>;

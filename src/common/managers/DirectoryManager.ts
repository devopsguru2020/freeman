import fs from "fs";
import { injectable } from "inversify";
import ncp from "ncp";
import path from "path";
import trash from "trash";
import { promisify } from "util";

import DirectoryError from "errors/DirectoryError";
import { IDirectoryManager } from "managers";
import { IDirectoryItem, IListDirectoryOptions } from "models";
import { DirectorySorter } from "objects";
import { ItemType } from "types";
import Utils from "Utils";

const lstatAsync = promisify(fs.lstat);
const rmdirAsync = promisify(fs.rmdir);
const unlinkAsync = promisify(fs.unlink);
const renameAsync = promisify(fs.rename);
const mkdirAsync = promisify(fs.mkdir);
const copyFileAsync = promisify(ncp.ncp);
const writeFileAsync = promisify(fs.writeFile);

/** Provides methods for reading, writing and creating files and folders. */
@injectable()
class DirectoryManager implements IDirectoryManager {

    /** A watcher that observes changes to a directory. */
    private watcher?: fs.FSWatcher;

    /**
     * Returns a list of paths of all files in the directory given in path.
     *
     * @param filePath - the path to the directory to list
     * @param options - an object of options to use when invoking the method
     *
     * @returns - a list of all files in the given directory
     */
    public async listDirectory(
        filePath: string,
        options: IListDirectoryOptions
    ): Promise<IDirectoryItem[]> {

        if (!(await DirectoryManager.isDirectory(filePath))) {
            throw new DirectoryError("Cannot call listDirectory on a non-directory item", filePath);
        }

        const filterCondition = options.filterCondition ? options.filterCondition :
            (item: IDirectoryItem) => true;
        const sort = options.sort ? options.sort :
            DirectorySorter.sortByTypeThenAlphaNumery;

        let fileList;

        try {
            fileList = await DirectoryManager.getDirectoryPaths(filePath);
        } catch {
            throw new DirectoryError("Could not list items in directory", filePath);
        }

        const filePromises = fileList.map(async fileName => {
            const fullPath = path.join(filePath, fileName);
            const fileStats = await lstatAsync(fullPath);

            return {
                name: fileName,
                path: fullPath,
                isDirectory: fileStats.isDirectory(),
                isHidden: await Utils.isHidden(fullPath, options.hideUnixStyleHiddenItems)
            } as IDirectoryItem;
        });

        const files = await Promise.all(filePromises);

        return sort(files).filter(filterCondition);
    }

    /**
     * Creates an item with itemName of itemType at itemPath.
     *
     * @param itemName - the name of the item to be created
     * @param itemPath - the path to the item to be created
     * @param itemType - the type of the item to be created
     */
    public async createItem(itemName: string, itemPath: string, itemType: ItemType): Promise<void> {
        const fullItemName = path.join(itemPath, itemName);

        if (itemType === "folder") {
            try {
                await mkdirAsync(fullItemName);
            } catch {
                throw new DirectoryError("Could not create directory", fullItemName);
            }
        } else {
            try {
                await writeFileAsync(fullItemName, "");
            } catch {
                throw new DirectoryError("Could not create file", fullItemName);
            }
        }
    }

    /**
     * Renames an item with oldName to newName at itemPath.
     *
     * @param oldName - the previous name
     * @param newName - the new name
     * @param itemPath - the path to the item to be renamed
     */
    public async renameItem(oldName: string, newName: string, itemPath: string): Promise<void> {
        if (oldName === newName) {
            return;
        }

        const oldNameFull = path.join(itemPath, oldName);
        const newNameFull = path.join(itemPath, newName);

        try {
            await renameAsync(oldNameFull, newNameFull);
        } catch {
            throw new DirectoryError("Could not rename item", oldNameFull, newNameFull);
        }
    }

    /**
     * Deletes the given itemsToDelete.
     *
     * @param itemsToDelete - an array of all directory items to delete
     */
    public async deleteItems(itemsToDelete: IDirectoryItem[]): Promise<void> {
        const itemDeletions = itemsToDelete.map(async item => {
            await DirectoryManager.deleteItem(item.path, Utils.parseItemType(item));
        });

        await Promise.all(itemDeletions);
    }

    /**
     * Sends the given itemsToTrash to the system-dependent trash.
     *
     * @param itemsToTrash - the items to send to trash
     */
    public async sendItemsToTrash(itemsToTrash: IDirectoryItem[]): Promise<void> {
        const itemSoftDeletions = itemsToTrash.map(async item => {
            await DirectoryManager.sendItemToTrash(item.path);
        });

        await Promise.all(itemSoftDeletions);
    }

    /**
     * Copies the given itemsToCopy to the destinationDirectory.
     *
     * @param itemsToCopy - the items to copy to destinationDirectory
     * @param destinationDirectory - the directory to copy the items to
     */
    public async copyItems(itemsToCopy: IDirectoryItem[], destinationDirectory: string): Promise<void> {
        const itemCopies = itemsToCopy.map(async item => {
            await DirectoryManager.copyItem(item.path, destinationDirectory);
        });

        await Promise.all(itemCopies);
    }

    /**
     * Moves the given itemsToCopy to the destinationDirectory.
     *
     * @param itemsToMove - the items to move to destinationDirectory
     * @param destinationDirectory - the directory to move the items to
     */
    public async moveItems(itemsToMove: IDirectoryItem[], destinationDirectory: string): Promise<void> {
        const itemMoves = itemsToMove.map(async item => {
            await DirectoryManager.moveItem(item.path, destinationDirectory, Utils.parseItemType(item));
        });

        await Promise.all(itemMoves);
    }

    /**
     * Reads the contents of the given file synchronously.
     *
     * @param filePath - the path to the file to read
     */
    public readFileSync(filePath: string): string {
        return fs.readFileSync(filePath, "utf-8");
    }

    /**
     * Starts watching pathToWatch, attaching listener to any change events.
     *
     * @param pathToWatch - the path to begin watching
     * @param listener - a callback function to invoke when pathToWatch changes
     */
    public startWatching(pathToWatch: string, listener: () => void) {
        this.watcher = fs.watch(pathToWatch, listener);
    }

    /** Stops watching any directory. */
    public stopWatching() {
        this.watcher && this.watcher.close();
    }

    /**
     * Copies an item at itemPath to the destinationDirectory.
     *
     * @param itemPath - the full path to the source item
     * @param destinationDirectory - the directory to copy the item to
     */
    private static async copyItem(itemPath: string, destinationDirectory: string): Promise<void> {
        const fileName = path.basename(itemPath);
        const destinationFileName = path.join(destinationDirectory, fileName);

        try {
            await copyFileAsync(itemPath, destinationFileName);
        } catch {
            throw new DirectoryError("Failed to copy item", itemPath, destinationFileName);
        }
    }

    /**
     * Moves an item at itemPath to the destinationDirectory. This involves deleting
     * permanently the source file.
     *
     * @param itemPath - the full path to the source item
     * @param destinationDirectory - the directory to move the item to
     * @param itemType - the type of the source item
     */
    private static async moveItem(itemPath: string, destinationDirectory: string, itemType: ItemType): Promise<void> {
        try {
            await DirectoryManager.copyItem(itemPath, destinationDirectory);
            await DirectoryManager.deleteItem(itemPath, itemType);
        } catch {
            throw new DirectoryError("Failed to copy item", itemPath, destinationDirectory);
        }
    }

    /**
     * Deletes the item of itemType at itemPath.
     *
     * @param itemPath - the full path to the item to be deleted
     * @param itemType - the type of the item to be deleted
     */
    private static async deleteItem(itemPath: string, itemType: ItemType): Promise<void> {
        if (itemType === "folder") {
            try {
                await rmdirAsync(itemPath);
            } catch {
                throw new DirectoryError("Cannot remove folder", itemPath);
            }
        } else {
            try {
                await unlinkAsync(itemPath);
            } catch {
                throw new DirectoryError("Cannot remove file", itemPath);
            }
        }
    }

    /**
     * Sends the item at itemPath to the system-dependent trash.
     *
     * @param itemPath - the path to the file
     */
    private static async sendItemToTrash(itemPath: string): Promise<void> {
        try {
            await trash([itemPath], { glob: false });
        } catch {
            throw new DirectoryError("Could not send item to trash", itemPath);
        }
    }

    /**
     * Returns whether the file at the given path is a directory.
     *
     * @param pathToItem - the path to the file
     *
     * @returns - whether the file is a directory
     */
    private static async isDirectory(pathToItem: string): Promise<boolean> {
        const stats = await lstatAsync(pathToItem);

        return stats.isDirectory();
    }

    /**
     * Returns a list of directory item paths in the given filePath.
     *
     * @param filePath - the path to the directory to get a list of files for
     *
     * @returns - a list of directory item paths in the given filePath
     */
    private static async getDirectoryPaths(filePath: string): Promise<string[]> {
        return new Promise<string[]>((resolve, reject) => {
            fs.readdir(filePath, (error, paths) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(paths);
                }
            });
        });
    }
}

export default DirectoryManager;
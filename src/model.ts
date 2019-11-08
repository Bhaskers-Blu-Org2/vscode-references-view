/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export class FileItem {

    private _document: Thenable<vscode.TextDocument> | undefined;

    constructor(
        readonly uri: vscode.Uri,
        readonly results: Array<ReferenceItem>,
        readonly parent: Model
    ) { }

    getDocument(warmUpNext?: boolean): Thenable<vscode.TextDocument> {
        if (!this._document) {
            this._document = vscode.workspace.openTextDocument(this.uri);
        }
        if (warmUpNext) {
            // load next document once this document has been loaded
            // and when next document has not yet been loaded
            const item = this.parent.move(this, true);
            if (item && !item.parent._document) {
                this._document.then(() => item.parent.getDocument(false))
            }
        }
        return this._document;
    }
}

export class ReferenceItem {
    constructor(
        readonly location: vscode.Location,
        readonly parent: FileItem,
    ) { }
}

export const enum ModelSource {
    References = 'vscode.executeReferenceProvider',
    Implementations = 'vscode.executeImplementationProvider'
}

export class Model {

    static async create(uri: vscode.Uri, position: vscode.Position, source: ModelSource): Promise<Model | undefined> {
        let locations = await vscode.commands.executeCommand<vscode.Location[]>(source, uri, position);
        if (!locations) {
            return undefined;
        }
        return new Model(source, uri, position, locations);
    }

    private readonly _onDidChange = new vscode.EventEmitter<Model | FileItem>();
    readonly onDidChange = this._onDidChange.event;

    readonly items: FileItem[];

    constructor(
        readonly source: ModelSource,
        readonly uri: vscode.Uri,
        readonly position: vscode.Position,
        locations: vscode.Location[]
    ) {
        this.items = [];
        let last: FileItem | undefined;
        locations.sort(Model._compareLocations);
        for (const loc of locations) {
            if (!last || last.uri.toString() !== loc.uri.toString()) {
                last = new FileItem(loc.uri, [], this);
                this.items.push(last);
            }
            last.results.push(new ReferenceItem(loc, last));
        }
    }

    get total(): number {
        let n = 0;
        for (const item of this.items) {
            n += item.results.length;
        }
        return n;
    }

    get(uri: vscode.Uri): FileItem | undefined {
        for (const item of this.items) {
            if (item.uri.toString() === uri.toString()) {
                return item;
            }
        }
        return undefined;
    }

    first(): ReferenceItem | undefined {
        if (this.items.length === 0) {
            return;
        }
        // NOTE: this.items is sorted by location (uri/range)
        for (const item of this.items) {
            if (item.uri.toString() === this.uri.toString()) {
                // (1) pick the item at the request position
                for (const ref of item.results) {
                    if (ref.location.range.contains(this.position)) {
                        return ref;
                    }
                }
                // (2) pick the first item after or last before the request position
                let lastBefore: ReferenceItem | undefined
                for (const ref of item.results) {
                    if (ref.location.range.end.isAfter(this.position)) {
                        return ref;
                    }
                    lastBefore = ref;
                }
                if (lastBefore) {
                    return lastBefore;
                }

                break;
            }
        }

        // (3) pick the file with the longest common prefix
        let best = 0;
        let bestValue = Model._prefixLen(this.items[best].toString(), this.uri.toString());

        for (let i = 1; i < this.items.length; i++) {
            let value = Model._prefixLen(this.items[i].uri.toString(), this.uri.toString());
            if (value > bestValue) {
                best = i;
            }
        }

        return this.items[best].results[0];
    }

    remove(item: FileItem | ReferenceItem): void {

        if (item instanceof FileItem) {
            Model._del(this.items, item);
            this._onDidChange.fire(this);

        } else if (item instanceof ReferenceItem) {
            Model._del(item.parent.results, item);
            if (item.parent.results.length === 0) {
                Model._del(this.items, item.parent);
                this._onDidChange.fire(this);
            } else {
                this._onDidChange.fire(item.parent);
            }
        }
    }

    move(item: FileItem | ReferenceItem, fwd: boolean): ReferenceItem | undefined {

        const delta = fwd ? +1 : -1;

        const _move = (item: FileItem): FileItem => {
            const idx = (this.items.indexOf(item) + delta + this.items.length) % this.items.length;
            return this.items[idx];
        }

        if (item instanceof FileItem) {
            if (fwd) {
                return _move(item).results[0];
            } else {
                return Model._tail(_move(item).results);
            }
        }

        if (item instanceof ReferenceItem) {
            const idx = item.parent.results.indexOf(item) + delta;
            if (idx < 0) {
                return Model._tail(_move(item.parent).results);
            } else if (idx >= item.parent.results.length) {
                return _move(item.parent).results[0];
            } else {
                return item.parent.results[idx];
            }
        }
    }

    private static _compareLocations(a: vscode.Location, b: vscode.Location): number {
        if (a.uri.toString() < b.uri.toString()) {
            return -1;
        } else if (a.uri.toString() > b.uri.toString()) {
            return 1;
        } else if (a.range.start.isBefore(b.range.start)) {
            return -1;
        } else if (a.range.start.isAfter(b.range.start)) {
            return 1;
        } else {
            return 0;
        }
    }

    private static _prefixLen(a: string, b: string): number {
        let pos = 0;
        while (pos < a.length && pos < b.length && a.charCodeAt(pos) === b.charCodeAt(pos)) {
            pos += 1;
        }
        return pos;
    }

    private static _del<T>(array: T[], e: T): void {
        const idx = array.indexOf(e);
        if (idx >= 0) {
            array.splice(idx, 1);
        }
    }

    private static _tail<T>(array: T[]): T | undefined {
        return array[array.length - 1];
    }
}

'use strict';
import * as vscode from 'vscode';

import { AngularCLITaskProvider } from './angularCLITaskProvider';

let subscription: vscode.Disposable;

export function activate(context: vscode.ExtensionContext) {
    if (!subscription) {
        subscription = vscode.workspace.registerTaskProvider('angularcli', new AngularCLITaskProvider());
        context.subscriptions.push(subscription);
    }    
}

export function deactivate() {
    //no-op
}
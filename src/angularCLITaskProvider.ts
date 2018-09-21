import * as vscode from 'vscode';

import * as path from 'path';
import * as fs from 'fs';
import { JSONVisitor, visit } from 'jsonc-parser';
// import * as semver from 'semver';

const DEFAULT_NG_BIN_LOCATION = 'node_modules/.bin/ng';

const ANGULAR_CLI_CONF_FILENAMES = ['angular-cli.json', '.angular-cli.json', 'angular.json'];
const TASK_TYPE = 'angularcli';
const TASK_SOURCE = 'ng';

enum RunOptions {
    Build = 'build',
    BuildWatch = 'build-watch',
    Serve = 'serve',
}

const runOptions = new Map<RunOptions, string>([
    [RunOptions.Build, 'build'],
    [RunOptions.BuildWatch, 'watch'],
    [RunOptions.Serve, 'serve'],
]);


export function removePrereleaseFromVersion(version: string) {
    const versionMatch = version.match(/(\d*)\.(\d*)\.(\d*)/);
    
    if (versionMatch !== null) {
        return versionMatch[0];
    } else {
        return version;
    }
}

async function readFile(file: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		fs.readFile(file, (err, data) => {
			if (err) {
				reject(err);
			}
			resolve(data.toString());
		});
	});
}

export async function fileExists(file: string, mode: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        fs.access(file, mode, (error) => {
            resolve(error ? false : true);
        });
    });
}

async function getAngularCLIConfigPath(workspaceFolder: vscode.WorkspaceFolder): Promise<string> {
    return new Promise<string>(async (resolve, reject) => {
        for (let filename of ANGULAR_CLI_CONF_FILENAMES) {
            if (await fileExists(path.join(workspaceFolder.uri.fsPath, filename), fs.constants.F_OK)) {
                resolve(filename);
            }
        }

        reject();
    });
}

interface PartialCustomTask {
    bin?: string;
    args?: string[];
    type: string;
    option: RunOptions;
    angular: string;
    [key: string]: string | string [] | undefined; 
}

const DefinitionFields = [
    'type',
    'option',
    // 'bin',
    // 'args',
    'angular',
];

function optionToParams(option: RunOptions): string[] {
    const args: string[] = [];

    switch (option) {
        case RunOptions.Build:
            args.push('build');
            break;
        case RunOptions.BuildWatch:
            args.push('build', '--watch');
            break;
        case RunOptions.Serve:
            args.push('serve');
            break;
    }

    return args;
}


export class AngularCLITaskProvider implements vscode.TaskProvider {
    async provideTasks(token?: vscode.CancellationToken | undefined): Promise<vscode.Task[]> {
        const folders = vscode.workspace.workspaceFolders;
        const tasks: vscode.Task[] = [];
        
        if (folders && folders.length) {
            const resolved = await Promise.all(
                folders.map( async (folder) => {
                    return await this.getTasks(folder);
                })
            );
            resolved.forEach(result => {
                tasks.push(...result);
            });
        }

        return tasks;
    }

    resolveTask(task: vscode.Task, token?: vscode.CancellationToken | undefined): vscode.ProviderResult<vscode.Task> {
        return undefined;
    }

    isAngularCLIProject(folder: vscode.WorkspaceFolder): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            getAngularCLIConfigPath(folder)
                .then(() => resolve(true))
                .catch(() => resolve(false));
        });
    }

    generateLabel(workspacefolder: vscode.WorkspaceFolder, runOption: RunOptions) {
        let label = '';

        const runOptionText = runOptions.get(runOption);
        if (runOptionText) {
            const workspaceFolders = vscode.workspace.workspaceFolders;

            if (workspaceFolders && workspaceFolders.length > 1) {
                label = `${runOptionText} - ${workspacefolder.name}`;
            } else {
                label = runOptionText;
            }
        } else {
            label = workspacefolder.name;
        }

        return label;
    }

    getDefaultTasks(workspaceFolder: vscode.WorkspaceFolder): vscode.Task[] {
        const tasks: vscode.Task[] = [];

        for (let runOption of runOptions) {
            const task = new vscode.Task(
                {
                    type: TASK_TYPE,
                    option: runOption[0],
                    angular: workspaceFolder.name
                },
                workspaceFolder,
                this.generateLabel(workspaceFolder, runOption[0]),
                TASK_SOURCE,
            );

            if (
                runOption[0] === RunOptions.Serve ||
                runOption[0] === RunOptions.BuildWatch
            ) {
                task.isBackground = true;
            }

            tasks.push(task);
        }

        return tasks;
    }

    appendStyleProblemMatchersIfNeeded(task: vscode.Task, manifestObject: any, version: string) {
        const problemMatchersToAdd = new Set<string>();
        
        if (
            manifestObject &&
            manifestObject.projects
        ) {
            Object.keys(manifestObject.projects).forEach(projectName => {
                const project = manifestObject.projects[projectName];
                if (
                    project.schematics &&
                    project.schematics['@schematics/angular:component'] &&
                    project.schematics['@schematics/angular:component'].styleext
                ) {
                    switch(project.schematics['@schematics/angular:component'].styleext) {
                        case 'sass':
                        case 'scss':
                            problemMatchersToAdd.add('$sass-loader')
                            break;
                        case 'less':
                            problemMatchersToAdd.add('$less-loader')
                            break;
                        case 'styl':
                            problemMatchersToAdd.add('$stylus-loader')
                            break;
                    }
                }

                if (
                    project.architect &&
                    project.architect.build &&
                    project.architect.build.options &&
                    project.architect.build.options.styles &&
                    project.architect.build.options.styles.length > 0
                ) {
                    project.architect.build.options.styles.forEach((styleFile: string) => {
                        const extension = path.extname(styleFile);
                        switch (extension) {
                            case '.scss':
                            case '.sass':
                                problemMatchersToAdd.add('$sass-loader');
                                break;
                            case '.less':
                                problemMatchersToAdd.add('$less-loader');
                                break;
                            case '.styl':
                                problemMatchersToAdd.add('$stylus-loader');
                                break;
                        }
                    });
                }
            });
        }

        if (
            manifestObject.defaults &&
            manifestObject.defaults.styleExt
        ) {
            const styleExt = manifestObject.defaults.styleExt;
            switch (styleExt) {
                case 'sass':
                case 'scss':
                    problemMatchersToAdd.add('$sass-loader')
                    break;
                case 'less':
                    problemMatchersToAdd.add('$less-loader')
                    break;
                case 'styl':
                    problemMatchersToAdd.add('$stylus-loader')
                    break;
                    
            }
        }

        for (let problemMatcher of problemMatchersToAdd) {
            task.problemMatchers.push(problemMatcher);
        }
    }

    public async getTasks(workspaceFolder: vscode.WorkspaceFolder, arg0?: any, arg1?: string): Promise<vscode.Task[]> {
        let tasks: vscode.Task[] = [];

        // const packageContents = await readFile(path.join(workspaceFolder.uri.fsPath, 'package.json'));

        // const manifestObject = JSON.parse(packageContents);

        // let version = '6.0.0';

        // if (
        //     manifestObject.devDependencies &&
        //     manifestObject.devDependencies['@angular/cli']
        // ) {
        //     version = manifestObject.devDependencies['@angular/cli'];
        // }

        // const cleanVersion = removePrereleaseFromVersion(version);
        const isAngularCLIProject = await this.isAngularCLIProject(workspaceFolder);

        if (isAngularCLIProject) {
            const defaultTasks = this.getDefaultTasks(workspaceFolder);
            const localNGPath = path.join(workspaceFolder.uri.fsPath, DEFAULT_NG_BIN_LOCATION);
            let suggestedNGBin: string;

            // Suggest to use local ng if detected, else use global
            if (await fileExists(localNGPath, fs.constants.X_OK | fs.constants.F_OK)) {
                suggestedNGBin = localNGPath;
            } else {
                suggestedNGBin = 'ng';
            }
            
            const customTasks = await this.getCustomTasks(workspaceFolder);

            fs.appendFileSync('/home/txava/out.txt', 'default tasks\n' );
            fs.appendFileSync('/home/txava/out.txt', JSON.stringify(defaultTasks)+'\n');
            fs.appendFileSync('/home/txava/out.txt', '\n\n' );
            fs.appendFileSync('/home/txava/out.txt', 'custom tasks\n' );
            fs.appendFileSync('/home/txava/out.txt', JSON.stringify(customTasks)+'\n');
            fs.appendFileSync('/home/txava/out.txt', '\n\n' );

            tasks = defaultTasks.map(task => {

                let isCodeMix = false;
                const customTaskIndex = customTasks.findIndex(customTask => {
                    return Object.keys(customTask)
                        .filter(key => DefinitionFields.indexOf(key) !== -1)
                        .every(key => {
                            return (task.definition as any)[key] === customTask[key];
                        });
                });

                if (customTaskIndex !== -1) {
                    const customTask = customTasks[customTaskIndex];

                    if (customTask.codemix) {
                        isCodeMix = true;
                    }

                    delete customTask.codemix;

                    Object.keys(customTask)
                        .forEach(key => {
                            task.definition[key] = customTask[key];
                        });
                    customTasks.splice(customTaskIndex, 1);
                    let bin = customTask.bin ? customTask.bin : suggestedNGBin;
                    let params: string[] = [];
                    if (
                        isCodeMix
                    ) {
                        bin = 'node_modules/.bin/tsc';
                        switch (task.definition.option) {
                            case RunOptions.BuildWatch:
                                params = ['--watch', '-p', workspaceFolder.uri.fsPath];
                                break;
                            case RunOptions.Build:
                                params = ['-p', workspaceFolder.uri.fsPath];
                                break;
                            default:
                                optionToParams(task.definition.option);
                        }
                    } else {
                        params = optionToParams(task.definition.option);
                    }
                    
                    task.execution = new vscode.ShellExecution(bin, params);
                } else {

                    if (
                        isCodeMix 
                    ) {
                        suggestedNGBin = 'node_modules/.bin/tsc';
                        const params = ['--watch', '-p', workspaceFolder.uri.fsPath];
                        // const params = task.definition.option === RunOptions.BuildWatch ? ['--watch', '-p', workspaceFolder.uri.fsPath] : optionToParams(task.definition.option);
                        task.execution = new vscode.ShellExecution(suggestedNGBin, params);
                    } else {
                        task.execution = new vscode.ShellExecution(suggestedNGBin, optionToParams(task.definition.option));
                    }
                }

                if (
                    isCodeMix 
                ) {
                    switch (task.definition.option) {
                        case RunOptions.BuildWatch:
                            task.problemMatchers = [ '$tsc-watch' ];
                            break;
                        case RunOptions.Build:
                            task.problemMatchers = [ '$tsc' ];
                            break;
                    }
                } else {
                    switch (task.definition.option) {
                        case RunOptions.BuildWatch:
                            task.problemMatchers = [ '$tsc-angular-cli-watch' ];
                            break;
                        case RunOptions.Build:
                            task.problemMatchers = [ '$tsc-angular-cli' ];
                            break;
                    }
                }

                // this.appendStyleProblemMatchersIfNeeded(task, manifestObject, version);

                return task;
            });

            tasks.push(
                ...customTasks.map(customTask => {
                    const taskDefinition: PartialCustomTask = {
                        type: customTask.type,
                        option: customTask.option,
                        angular: customTask.angular
                    };
                    // let isCodeMix = false;

                    // if (customTask.codemix) {
                    //     isCodeMix = true;
                    // }

                    delete customTask.codemix;

                    Object.keys(customTask)
                        .filter(key => {
                            return DefinitionFields.indexOf(key) !== -1;
                        })
                        .forEach(key => {
                        taskDefinition[key] = customTask[key];
                    });
                    const bin = customTask.bin ? customTask.bin : suggestedNGBin;
                    
                    let args = optionToParams(taskDefinition.option);
                    if (customTask.args && customTask.args.length) {
                        args.push(...customTask.args);
                    }

                    const task = new vscode.Task(
                        taskDefinition,
                        workspaceFolder,
                        this.generateLabel(workspaceFolder, taskDefinition.option),
                        TASK_SOURCE,
                        new vscode.ShellExecution(bin, args)
                    );

                    if (
                        customTask.option === RunOptions.Serve ||
                        customTask.option === RunOptions.BuildWatch
                    ) {
                        task.isBackground = true;
                    }

                    return task;
                })
            );

        } 

        fs.appendFileSync('/home/txava/out.txt', 'end tasks\n' );
        fs.appendFileSync('/home/txava/out.txt', JSON.stringify(tasks) );

        return tasks;
    }
    
    async getCustomTasks(workspaceFolder: vscode.WorkspaceFolder): Promise<PartialCustomTask[]> {
        const tasks: PartialCustomTask[] = [];
        const projectCustomTasksPath = path.join(workspaceFolder.uri.fsPath, '.vscode/tasks.json');

        if (await fileExists(projectCustomTasksPath, fs.constants.F_OK)) {
            const buffer = await readFile(projectCustomTasksPath);
            let inEntry = false;
            let isOurTaskType = false;
            let taskTypeIdentified = false;
            let inTasks = false;
            let currentTaskEntryProperties = new Map<string, any>();
            let currentEntryField: string;
            let taskArgs: string[] | undefined = undefined;
            
            let objectNestingLevel = 0;
        
            let visitor: JSONVisitor = {
                onObjectEnd() {
                    if (inEntry) {
                        if (objectNestingLevel === 0) {
                            inEntry = false;
                            if (isOurTaskType) {
                                let angularWorkspaceFolder = currentTaskEntryProperties.get('angular');
                                if (typeof angularWorkspaceFolder === 'string') {
                                    angularWorkspaceFolder = angularWorkspaceFolder.replace('${workspaceFolder}', workspaceFolder.name);
                                }
                                const task: PartialCustomTask = {
                                    type: TASK_TYPE,
                                    option: currentTaskEntryProperties.get('option'),
                                    bin: currentTaskEntryProperties.get('bin') || undefined,
                                    port: currentTaskEntryProperties.get('port') || undefined,
                                    angular: angularWorkspaceFolder
                                };
    
                                for(let entry of currentTaskEntryProperties.entries()) {
                                    task[entry[0]] = entry[1];
                                }
                                task.angular = angularWorkspaceFolder;
                                
                                tasks.push(task);
                            }
    
                            currentTaskEntryProperties.clear();
                        } else {
                            objectNestingLevel -= 1;
                        }
                    }
                },
                onArrayEnd(offset: number, length: number) {
                    if (!inEntry) {
                        inTasks = false;
                    } else {
                        if (currentEntryField === 'args') {
                            currentTaskEntryProperties.set('args', taskArgs);
                            taskArgs = undefined;
                        }
                    }
                },
                onLiteralValue(value: any, _offset: number, _length: number) {
                    if (inEntry && objectNestingLevel === 0) {
                        if (currentEntryField === 'args') {
                            if (taskArgs === undefined) {
                                taskArgs = [];
                            }
                            taskArgs.push(value);
                        } else {
                            currentTaskEntryProperties.set(currentEntryField, value);
                        }

                        if (currentEntryField === 'type') {
                            taskTypeIdentified = true;
                            isOurTaskType = value === TASK_TYPE ? true : false;
                        } 
                    }
                },
                onObjectProperty(property: string, _offset: number, _length: number) {
                    if (inTasks) {
                        if (
                            !taskTypeIdentified ||
                            (taskTypeIdentified && isOurTaskType)
                        ) {
                            currentEntryField = property;

                            if (currentEntryField === 'codemix') {
                                currentTaskEntryProperties.set('codemix', true);
                            }
                        }
                    } else {
                        if (property === 'tasks') {
                            inTasks = true;
                        }
                    }
                },
                onObjectBegin(offset: number, length: number) {
                    if (inEntry) {
                        objectNestingLevel += 1;
                    } else {
                        if (inTasks && !inEntry) {
                            inEntry = true;
                        }
                    }
                }
            };
        
            visit(buffer, visitor);
        }

        return tasks;
    }

}

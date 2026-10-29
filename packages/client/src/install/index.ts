// Installing and updating engines from the app (spec §9.2, H22): the host's shell, over SSH, through
// wsl.exe or on this machine; the check of a host; where the engine comes from and how it is verified;
// the install's steps and their failures. What crosses to the renderer is `outcome.ts`, which the
// package's root exports too, as it has no Node in it.
export * from './distribution'
export * from './failure'
export * from './install'
export * from './outcome'
export * from './probe'
export * from './shell'

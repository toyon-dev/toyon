// The Toyon.app bundle's executable. A plain C stub that execs the launch script never hears
// about a file dropped on the Dock icon: that arrives as an Apple Event, which only an
// NSApplication receives. So this is the smallest Cocoa app there is: it collects the paths the
// event names, answers the event (Finder waits on the answer, and an exec before it would leave
// Finder hanging), and once launched execs the script with those paths. The open-files call comes
// before the finish-launching one, which is why the paths are collected first and the exec waits
// for the second. With nothing dropped the script runs with no arguments.
//
// Read into the CLI as text (app.ts) and compiled at `toyon --install-app` on the machine itself.
#import <Cocoa/Cocoa.h>
#include <libgen.h>
#include <mach-o/dyld.h>
#include <stdlib.h>
#include <unistd.h>

@interface Launcher : NSObject <NSApplicationDelegate>
@property(strong) NSMutableArray<NSString *> *paths;
@end

@implementation Launcher
- (void)application:(NSApplication *)app openFiles:(NSArray<NSString *> *)files {
  [self.paths addObjectsFromArray:files];
  [app replyToOpenOrPrint:NSApplicationDelegateReplySuccess];
}
- (BOOL)applicationSupportsSecureRestorableState:(NSApplication *)app {
  return YES;
}
- (void)applicationDidFinishLaunching:(NSNotification *)note {
  char self_[4096];
  uint32_t n = sizeof(self_);
  if (_NSGetExecutablePath(self_, &n) != 0) exit(1);
  NSString *script = [NSString stringWithFormat:@"%s/../Resources/launch.sh", dirname(self_)];
  NSMutableArray<NSString *> *argv = [NSMutableArray arrayWithObjects:@"bash", script, nil];
  [argv addObjectsFromArray:self.paths];
  const char **cargv = calloc(argv.count + 1, sizeof(char *));
  for (NSUInteger i = 0; i < argv.count; i++) cargv[i] = [argv[i] fileSystemRepresentation];
  execv("/bin/bash", (char *const *)cargv);
  exit(1);
}
@end

int main(void) {
  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    Launcher *launcher = [Launcher new];
    launcher.paths = [NSMutableArray new];
    app.delegate = launcher;
    [app run];
  }
  return 0;
}

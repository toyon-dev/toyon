// The helper bundle's executable (core/helper.ts). A plain C stub that execs the launch script
// never hears about a file the system hands over or a link on the bundle's URL scheme: both
// arrive as Apple Events, which only an NSApplication receives. So this is the smallest Cocoa app
// there is: it collects what the events name, answers them (Finder waits on the answer, and an
// exec before it would leave Finder hanging), and once launched execs the script with those as
// arguments. The open calls come before the finish-launching one, which is why they are collected
// first and the exec waits for the second. A link on the scheme and a file handed over by Launch
// Services both come through the URL call, as a URL string each; a dropped file comes as a path.
//
// Built once by scripts/stub.ts into the daemon's dist (a universal binary, shipped in the npm
// package); core/helper.ts copies it into the bundle it writes.
#import <Cocoa/Cocoa.h>
#include <libgen.h>
#include <mach-o/dyld.h>
#include <stdlib.h>
#include <unistd.h>

@interface Launcher : NSObject <NSApplicationDelegate>
@property(strong) NSMutableArray<NSString *> *args;
@end

@implementation Launcher
- (void)application:(NSApplication *)app openFiles:(NSArray<NSString *> *)files {
  [self.args addObjectsFromArray:files];
  [app replyToOpenOrPrint:NSApplicationDelegateReplySuccess];
}
- (void)application:(NSApplication *)app openURLs:(NSArray<NSURL *> *)urls {
  for (NSURL *url in urls) [self.args addObject:url.absoluteString];
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
  [argv addObjectsFromArray:self.args];
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
    launcher.args = [NSMutableArray new];
    app.delegate = launcher;
    [app run];
  }
  return 0;
}

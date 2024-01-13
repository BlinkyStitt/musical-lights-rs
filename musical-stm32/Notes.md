This is currently being written for the STM32 discovery, but I plan on using a blackpill in the final project. They are similar, but there will be some changes

## If the blackpill won't flash.

This can happen if you flash a broken program. Either fix the program or flash something simple like "blinky".

To make this less likely to happen, I like to have my programs sleep for 2-5 seconds very near the start

1. unplug
2. hold boot0 button
3. plug
3. start flashing. as soon as it starts erasing the existing firmware, LET GO OF BOOT0!
4. the flash should succeed. if it fails, try flashing again.

## Watchdog

I need to read more about patterns for watch dog timers. it should probably sleep for a short time and then reboot. or while deving, sleep forever

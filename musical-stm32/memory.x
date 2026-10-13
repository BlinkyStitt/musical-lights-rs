MEMORY
{
  FLASH : ORIGIN = 0x08000000, LENGTH = 256K
  RAM : ORIGIN = 0x20000000, LENGTH = 128K
}
/* STM32F411CE: sectors 6 and 7 belong exclusively to the checkpoint journal. */
ASSERT(ORIGIN(FLASH) + LENGTH(FLASH) <= 0x08040000, "firmware overlaps journal");

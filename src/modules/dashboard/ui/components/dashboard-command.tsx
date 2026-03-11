import { Dispatch, SetStateAction } from "react";
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

interface Props {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
}

export const DashboardCommand = ({ open, setOpen }: Props) => {
    return (
        <CommandDialog open={open} onOpenChange={setOpen}>
            <Command>
                <CommandInput placeholder="Find A Meeting Or Agent" />
                <CommandList>
                    <CommandItem>Test</CommandItem>
                </CommandList>
            </Command>
        </CommandDialog>
    );
};
import { Dispatch, SetStateAction } from "react";
import {
  Command,
  CommandResponsiveDialog,
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
        <CommandResponsiveDialog open={open} onOpenChange={setOpen}>
            <Command>
                <CommandInput placeholder="Find A Meeting Or Agent" />
                <CommandList>
                    <CommandItem>Test 1</CommandItem>
                    <CommandItem>Test 2</CommandItem>
                </CommandList>
            </Command>
        </CommandResponsiveDialog>
    );
};
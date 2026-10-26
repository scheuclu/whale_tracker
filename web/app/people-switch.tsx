import { Segmented } from "./ui";

/**
 * The People section's two directories, as one segmented control at the top
 * of each: members of Congress and corporate insiders. Two populations, two
 * pages, never one list.
 */
export function PeopleSwitch({ active }: { active: "congress" | "insiders" }) {
  return (
    <nav aria-label="People" className="scrollbar-none -m-1 max-w-full overflow-x-auto p-1">
      <Segmented
        label="People"
        items={[
          { key: "congress", label: "Congress", href: "/politicians", active: active === "congress" },
          { key: "insiders", label: "Insiders", href: "/insiders", active: active === "insiders" },
        ]}
      />
    </nav>
  );
}

// Example projects contributed by the AGREE plug-in.

const TOY = `package Toy_Example
public
  with Base_Types;

  -- Top-level system: its guarantee is proved from the subcomponent contracts.
  system A
    features
      Input: in data port Base_Types::Integer;
      Output: out data port Base_Types::Integer;
    annex agree {**
      assume "A input range" : Input < 20;
      guarantee "A output range" : Output < 50;
    **};
  end A;

  system B
    features
      Input: in data port Base_Types::Integer;
      Output: out data port Base_Types::Integer;
    annex agree {**
      assume "B input range" : Input < 20;
      guarantee "B output range" : Output < Input + 15;
    **};
  end B;

  system C
    features
      Input: in data port Base_Types::Integer;
      Output: out data port Base_Types::Integer;
    annex agree {**
      assume "C input range" : Input < 40;
      guarantee "C output range" : Output <= Input + 10;
    **};
  end C;

  system implementation A.impl
    subcomponents
      sub_B: system B;
      sub_C: system C;
    connections
      c1: port Input -> sub_B.Input;
      c2: port sub_B.Output -> sub_C.Input;
      c3: port sub_C.Output -> Output;
    annex agree {**
      -- Try changing 50 to 40 in A's guarantee to see a counterexample.
      lemma "B output feeds C within range" : sub_B.Output < 35;
    **};
  end A.impl;
end Toy_Example;
`;

const COUNTER_LIB = `package Counter_Lib
public
  annex agree {**
    const MAX : int = 5;

    -- Clamp a value into [lo, hi].
    node saturate(x : int, lo : int, hi : int) returns (r : int);
    let
      r = if x < lo then lo else if x > hi then hi else x;
    tel;
  **};
end Counter_Lib;
`;

const COUNTER = `package Counter_System
public
  with Base_Types, Counter_Lib;

  system Counter
    features
      reset: in data port Base_Types::Boolean;
      count: out data port Base_Types::Integer;
    annex agree {**
      guarantee "count starts at 0, increments, and wraps at MAX" :
        count = (0 -> if reset or pre(count) >= Counter_Lib::MAX then 0 else pre(count) + 1);
    **};
  end Counter;

  system Display
    features
      value: in data port Base_Types::Integer;
      shown: out data port Base_Types::Integer;
    annex agree {**
      assume "value is never negative" : value >= 0;
      guarantee "shown value is the clamped input" : shown = Counter_Lib::saturate(value, 0, 9);
    **};
  end Display;

  system Top
    features
      reset: in data port Base_Types::Boolean;
      shown: out data port Base_Types::Integer;
    annex agree {**
      eq in_range : bool = shown >= 0 and shown <= Counter_Lib::MAX;
      guarantee "display stays within 0..MAX" : in_range;
      guarantee "reset shows 0 on the next step" : true -> (pre(reset) => shown = 0 or shown = 1);
    **};
  end Top;

  system implementation Top.impl
    subcomponents
      ctr: system Counter;
      disp: system Display;
    connections
      c1: port reset -> ctr.reset;
      c2: port ctr.count -> disp.value;
      c3: port disp.shown -> shown;
    annex agree {**
      -- Invalid on purpose: the counter does reach MAX. Verify to see the counterexample.
      lemma "counter never reaches MAX" : ctr.count < Counter_Lib::MAX;
    **};
  end Top.impl;
end Counter_System;
`;

export const AGREE_EXAMPLES = [
  {
    id: "agree-toy",
    name: "AGREE: Toy example",
    description: "Three-component pipeline whose top-level guarantee follows from its parts.",
    files: [{ name: "Toy_Example.aadl", text: TOY }],
    target: "Toy_Example::A.impl",
  },
  {
    id: "agree-counter",
    name: "AGREE: Counter with state",
    description: "Uses pre/->, a library constant and node, an eq, and an invalid lemma with a counterexample.",
    files: [
      { name: "Counter_Lib.aadl", text: COUNTER_LIB },
      { name: "Counter_System.aadl", text: COUNTER },
    ],
    target: "Counter_System::Top.impl",
  },
];

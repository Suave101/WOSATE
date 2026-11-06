// Predeclared AADL content that OSATE ships as plug-in contributions.

import { STANDARD_PROPERTY_SETS, PREDECLARED_SETS } from "./stdlib.js";

export { PREDECLARED_SETS };

/**
 * Property sets that may appear in `with` clauses without a definition being loaded.
 * Associations using them are accepted but not checked.
 */
export const KNOWN_UNLOADED_PROPERTY_SETS = [
  "ARINC429", "Physical", "Code_Generation_Properties", "Classifier_Matching_Rules", "Classifier_Properties",
  "Behavior_Properties", "Physical_Types", "Resolute", "AGREE", "BLESS",
];

export const BASE_TYPES = `-- Contributed by WOSATE (equivalent of the OSATE Base_Types plug-in contribution)
package Base_Types
public
  with Data_Model;

  data Boolean
    properties
      Data_Model::Data_Representation => Boolean;
  end Boolean;

  data Integer
    properties
      Data_Model::Data_Representation => Integer;
  end Integer;

  data Integer_8 extends Integer
  end Integer_8;
  data Integer_16 extends Integer
  end Integer_16;
  data Integer_32 extends Integer
  end Integer_32;
  data Integer_64 extends Integer
  end Integer_64;

  data Unsigned_8 extends Integer
  end Unsigned_8;
  data Unsigned_16 extends Integer
  end Unsigned_16;
  data Unsigned_32 extends Integer
  end Unsigned_32;
  data Unsigned_64 extends Integer
  end Unsigned_64;

  data Natural extends Integer
  end Natural;

  data Float
    properties
      Data_Model::Data_Representation => Float;
  end Float;

  data Float_32 extends Float
  end Float_32;
  data Float_64 extends Float
  end Float_64;

  data Character
    properties
      Data_Model::Data_Representation => Character;
  end Character;

  data String
    properties
      Data_Model::Data_Representation => String;
  end String;
end Base_Types;
`;

export const CORE_LIBRARIES = [
  ...STANDARD_PROPERTY_SETS.map((l) => ({ ...l, readOnly: true })),
  { name: "Base_Types.aadl", text: BASE_TYPES, readOnly: true },
];

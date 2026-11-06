// Example model for the EMV2 plug-in: a redundant-sensor infusion pump.

const TEXT = `package Pump_Safety
public
  with Base_Types, EMV2, ARP4761;

  device Sensor
    features
      reading: out data port Base_Types::Float;
    annex EMV2 {**
      use types ErrorLibrary;
      use behavior ErrorLibrary::FailStop;
      error propagations
        reading: out propagation {ServiceOmission, OutOfRange};
      flows
        range_src: error source reading{OutOfRange};
      end propagations;
      component error behavior
        propagations
          FailStop -[ ]-> reading{ServiceOmission};
      end component;
      properties
        EMV2::OccurrenceDistribution => [ ProbabilityValue => 1.0e-4; Distribution => Fixed; ] applies to Failure;
        EMV2::OccurrenceDistribution => [ ProbabilityValue => 5.0e-5; Distribution => Fixed; ] applies to range_src;
        EMV2::Severity => ARP4761::Major applies to reading.OutOfRange;
        EMV2::DetectionMechanism => "Range check in controller" applies to reading.OutOfRange;
    **};
  end Sensor;

  process Controller
    features
      in1: in data port Base_Types::Float;
      in2: in data port Base_Types::Float;
      cmd: out data port Base_Types::Float;
    annex EMV2 {**
      use types ErrorLibrary;
      use behavior ErrorLibrary::FailStop;
      error propagations
        in1: in propagation {ServiceOmission, OutOfRange};
        in2: in propagation {ServiceOmission, OutOfRange};
        cmd: out propagation {ServiceOmission, OutOfRange};
      flows
        range1: error path in1{OutOfRange} -> cmd{OutOfRange};
        range2: error path in2{OutOfRange} -> cmd{OutOfRange};
      end propagations;
      component error behavior
        transitions
          both_lost: Operational -[ in1{ServiceOmission} and in2{ServiceOmission} ]-> FailStop;
        propagations
          FailStop -[ ]-> cmd{ServiceOmission};
      end component;
      properties
        EMV2::OccurrenceDistribution => [ ProbabilityValue => 1.0e-6; Distribution => Fixed; ] applies to Failure;
    **};
  end Controller;

  device Pump
    features
      cmd: in data port Base_Types::Float;
    annex EMV2 {**
      use types ErrorLibrary;
      use behavior ErrorLibrary::FailStop;
      error propagations
        cmd: in propagation {ServiceOmission, OutOfRange};
      flows
        bad_cmd: error sink cmd{OutOfRange};
      end propagations;
      component error behavior
        transitions
          no_cmd: Operational -[ cmd{ServiceOmission} ]-> FailStop;
      end component;
      properties
        EMV2::OccurrenceDistribution => [ ProbabilityValue => 2.0e-5; Distribution => Fixed; ] applies to Failure;
        EMV2::Hazards => ([
          CrossReference => "H-1";
          HazardTitle => "Loss of infusion";
          Description => "The pump stops delivering medication";
          Failure => "Pump enters FailStop";
          FailureEffect => "Patient does not receive therapy";
          Phases => ("Infusion");
          Severity => ARP4761::Hazardous;
          Likelihood => ARP4761::Remote;
        ]) applies to FailStop;
    **};
  end Pump;

  system Infusion_System
  end Infusion_System;

  system implementation Infusion_System.impl
    subcomponents
      s1: device Sensor;
      s2: device Sensor;
      ctrl: process Controller;
      pump: device Pump;
    connections
      c1: port s1.reading -> ctrl.in1;
      c2: port s2.reading -> ctrl.in2;
      c3: port ctrl.cmd -> pump.cmd;
    annex EMV2 {**
      use types ErrorLibrary;
      use behavior ErrorLibrary::FailStop;
      composite error behavior
        states
          [ pump.FailStop or ctrl.FailStop or (s1.FailStop and s2.FailStop) ]-> FailStop;
      end composite;
    **};
  end Infusion_System.impl;
end Pump_Safety;
`;

export const EMV2_EXAMPLE = {
  id: "emv2-pump",
  name: "EMV2: Infusion pump safety",
  description: "Redundant sensors, error propagation, composite behavior, FMEA, fault tree and hazard log.",
  files: [{ name: "Pump_Safety.aadl", text: TEXT }],
  target: "Pump_Safety::Infusion_System.impl",
};
